/**
 * process-document — Supabase Edge Function
 * ==========================================
 * Triggered after a student uploads a file to Supabase Storage.
 * Pipeline:
 *   1. Authenticate the student (JWT → auth.uid())
 *   2. Verify the student owns the resource
 *   3. Download the file from Storage (service-role)
 *   4. Extract text (unpdf for PDF, mammoth for DOCX, TextDecoder for TXT)
 *   5. Split into ~400-char overlapping chunks
 *   6. Embed each chunk with Supabase gte-small (free, in-process)
 *   7. Bulk-insert into document_chunks (service-role)
 *   8. Mark resources.is_indexed = true
 *
 * Security:
 *   - Student JWT verified via userClient.auth.getUser()
 *   - Resource ownership checked before any processing
 *   - Service-role key only used AFTER ownership is confirmed
 *   - No LLM API key is needed for document indexing
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'npm:unpdf';
import mammoth from 'npm:mammoth';

// ── Constants ──────────────────────────────────────────────────────────────
const CHUNK_SIZE       = 400;   // characters per chunk
const CHUNK_OVERLAP    = 60;    // character overlap between adjacent chunks
const CHARS_PER_PAGE   = 3000;  // estimate: ~3000 chars ≈ 1 page
const MAX_CHUNKS       = 150;   // hard cap per document (prevents OOM on huge PDFs)

// ── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  let processingClient: ReturnType<typeof createClient> | undefined;
  let processingResourceId: string | undefined;

  try {
    // ── 1. Parse request ────────────────────────────────────────────────
    const { resource_id } = await req.json() as { resource_id: string };
    if (!resource_id) {
      return error(400, 'Missing resource_id');
    }

    // ── 2. Authenticate student ─────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return error(401, 'Missing Authorization header');

    const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // User-scoped client (respects RLS — used for auth + ownership check)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return error(401, 'Invalid or expired session');

    // ── 3. Verify resource ownership ────────────────────────────────────
    const { data: resource, error: resErr } = await userClient
      .from('resources')
      .select('id, student_id, storage_path, file_name')
      .eq('id', resource_id)
      .single();

    if (resErr || !resource) return error(404, 'Resource not found');
    if (resource.student_id !== user.id) return error(403, 'Access denied');

    // ── 4. Download file from Storage ───────────────────────────────────
    // Service-role client only used here (after ownership confirmed)
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    processingClient = adminClient;
    processingResourceId = resource_id;

    const { error: processingErr } = await adminClient
      .from('resources')
      .update({
        is_indexed: false,
        processing_status: 'processing',
        processing_error: null,
      })
      .eq('id', resource_id);

    if (processingErr) {
      throw new Error(`Could not update document status: ${processingErr.message}`);
    }

    const { data: fileBlob, error: dlErr } = await adminClient.storage
      .from('student-resources')
      .download(resource.storage_path);

    if (dlErr || !fileBlob) {
      throw new Error(`Storage download failed: ${dlErr?.message || 'No file was returned.'}`);
    }

    const arrayBuffer = await fileBlob.arrayBuffer();

    // ── 5. Extract text ─────────────────────────────────────────────────
    const fileName    = resource.file_name.toLowerCase();
    const extractedText = await extractTextFromFile(arrayBuffer, fileName);

    if (!extractedText || extractedText.trim().length < 10) {
      const message = 'Could not extract readable text from this file. Try converting it to PDF or TXT.';
      const { error: statusErr } = await adminClient
        .from('resources')
        .update({
          is_indexed: false,
          processing_status: 'failed',
          processing_error: message,
        })
        .eq('id', resource_id);

      if (statusErr) throw new Error(`Could not update document status: ${statusErr.message}`);
      return error(422, message);
    }

    // ── 6. Chunk the text ───────────────────────────────────────────────
    const chunks = chunkText(extractedText, CHUNK_SIZE, CHUNK_OVERLAP);
    const cappedChunks = chunks.slice(0, MAX_CHUNKS);
    if (cappedChunks.length === 0) {
      throw new Error('No text chunks could be created from this document.');
    }

    // ── 7. Embed each chunk with Supabase gte-small ─────────────────────
    // @ts-ignore — Supabase.ai is injected by the Edge Runtime
    const session = new Supabase.ai.Session('gte-small');

    // First, delete any existing chunks for this resource (re-indexing)
    const { error: deleteErr } = await adminClient
      .from('document_chunks')
      .delete()
      .eq('resource_id', resource_id);
    if (deleteErr) {
      throw new Error(`Could not replace existing document chunks: ${deleteErr.message}`);
    }

    // Embed + insert in batches of 10 to avoid memory spikes
    const BATCH = 10;
    for (let i = 0; i < cappedChunks.length; i += BATCH) {
      const batch = cappedChunks.slice(i, i + BATCH);

      const rows = await Promise.all(
        batch.map(async (chunk, batchIdx) => {
          const globalIdx = i + batchIdx;
          const embedding = await session.run(chunk.text, {
            mean_pool: true,
            normalize: true,
          });
          return {
            student_id:  user.id,
            resource_id: resource_id,
            chunk_index: globalIdx,
            page_number: chunk.page,
            content:     chunk.text,
            embedding:   JSON.stringify(Array.from(embedding.data ?? embedding)),
          };
        })
      );

      const { error: insertErr } = await adminClient
        .from('document_chunks')
        .insert(rows);

      if (insertErr) {
        throw new Error(`Could not save document chunks: ${insertErr.message}`);
      }
    }

    // ── 8. Mark resource as indexed ─────────────────────────────────────
    const { error: statusErr } = await adminClient
      .from('resources')
      .update({
        is_indexed: true,
        processing_status: 'indexed',
        processing_error: null,
        chunk_count: cappedChunks.length,
      })
      .eq('id', resource_id);
    if (statusErr) {
      throw new Error(`Could not mark document as indexed: ${statusErr.message}`);
    }

    return new Response(
      JSON.stringify({
        success:     true,
        chunk_count: cappedChunks.length,
        truncated:   chunks.length > MAX_CHUNKS,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('process-document unhandled error:', msg);
    if (processingClient && processingResourceId) {
      const { error: statusErr } = await processingClient
        .from('resources')
        .update({
          is_indexed: false,
          processing_status: 'failed',
          processing_error: msg,
        })
        .eq('id', processingResourceId);
      if (statusErr) {
        console.error('Could not mark document indexing as failed:', statusErr.message);
      }
    }
    return error(500, msg);
  }
});

// ── Text extraction ────────────────────────────────────────────────────────
async function extractTextFromFile(buf: ArrayBuffer, fileName: string): Promise<string> {
  if (fileName.endsWith('.pdf')) {
    const pdf  = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (fileName.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }
  if (fileName.endsWith('.doc')) {
    // .doc (old binary format) — mammoth handles some cases
    try {
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      return result.value;
    } catch {
      return '';
    }
  }
  if (fileName.endsWith('.txt')) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  // PPT/PPTX — no reliable Deno parser; return empty to trigger 422
  return '';
}

// ── Text chunking ──────────────────────────────────────────────────────────
function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): Array<{ text: string; page: number }> {
  // Normalise whitespace
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: Array<{ text: string; page: number }> = [];
  let start = 0;

  while (start < clean.length) {
    const end  = Math.min(start + chunkSize, clean.length);
    const slice = clean.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({
        text: slice,
        page: Math.floor(start / CHARS_PER_PAGE) + 1,
      });
    }
    if (end === clean.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

// ── Error response helper ──────────────────────────────────────────────────
function error(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
}
