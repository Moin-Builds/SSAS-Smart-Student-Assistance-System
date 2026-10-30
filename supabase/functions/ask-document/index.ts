/**
 * ask-document — Supabase Edge Function
 * =======================================
 * Handles student questions about their uploaded documents (RAG).
 * Pipeline:
 *   1. Authenticate student (JWT)
 *   2. Verify student owns the requested resource
 *   3. Embed the student's question with gte-small
 *   4. Cosine similarity search via match_document_chunks() RPC
 *   5. Assemble retrieved chunks as context
 *   6. Call Gemini with a grounded prompt
 *   7. Return answer + source citations
 *
 * Security:
 *   - JWT verified; resource ownership confirmed before any data access
 *   - similarity search is scoped to student_id + resource_id (double-locked)
 *   - GEMINI_API_KEY accessed only via Deno.env.get() — never exposed to client
 *   - No service-role key used here (reads only, RLS handles isolation)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const TOP_K          = 5;       // number of chunks to retrieve
const SIM_THRESHOLD  = 0.35;    // minimum cosine similarity (0 = unrelated, 1 = identical)
const MAX_CTX_CHARS  = 3000;    // maximum context characters sent to the LLM

// ── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    // ── 1. Parse request ────────────────────────────────────────────────
    const { resource_id, question } = await req.json() as {
      resource_id: string;
      question:    string;
    };

    if (!resource_id) return error(400, 'Missing resource_id');
    if (!question || question.trim().length < 3) return error(400, 'Question is too short');

    const cleanQuestion = question.trim().slice(0, 500); // cap input length

    // ── 2. Authenticate student ─────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return error(401, 'Missing Authorization header');

    const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const GEMINI_API_KEY    = Deno.env.get('GEMINI_API_KEY');
    const GEMINI_MODEL      = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';

    if (!GEMINI_API_KEY) return error(503, 'Gemini API key is not configured on the server');

    // User-scoped client (RLS enforced on all reads)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return error(401, 'Invalid or expired session');

    // ── 3. Verify resource ownership ────────────────────────────────────
    const { data: resource, error: resErr } = await userClient
      .from('resources')
      .select('id, student_id, file_name, is_indexed')
      .eq('id', resource_id)
      .single();

    if (resErr || !resource)          return error(404, 'Resource not found');
    if (resource.student_id !== user.id) return error(403, 'Access denied');
    if (!resource.is_indexed)         return error(422, 'This document has not been indexed yet. Please wait a moment and try again.');

    // ── 4. Embed the question ───────────────────────────────────────────
    // @ts-ignore — Supabase.ai is injected by the Edge Runtime
    const session = new Supabase.ai.Session('gte-small');
    const questionEmbedding = await session.run(cleanQuestion, {
      mean_pool: true,
      normalize: true,
    });
    const embeddingArray = Array.from(questionEmbedding.data ?? questionEmbedding);

    // ── 5. Similarity search via RPC ────────────────────────────────────
    const { data: chunks, error: rpcErr } = await userClient.rpc(
      'match_document_chunks',
      {
        query_embedding:   embeddingArray,
        match_student_id:  user.id,
        match_resource_id: resource_id,
        match_count:       TOP_K,
        match_threshold:   SIM_THRESHOLD,
      }
    );

    if (rpcErr) {
      console.error('match_document_chunks RPC error:', rpcErr.message);
      return error(500, 'Similarity search failed: ' + rpcErr.message);
    }

    if (!chunks || chunks.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          answer:  "I couldn't find relevant content in this document for your question. Try rephrasing, or check that the document has been fully indexed.",
          sources: [],
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── 6. Assemble context ─────────────────────────────────────────────
    let contextText = '';
    const sources: Array<{
      chunk_index: number;
      page_number:  number | null;
      excerpt:      string;
      similarity:   number;
    }> = [];

    for (const chunk of chunks) {
      const label   = `[Chunk ${chunk.chunk_index + 1}${chunk.page_number ? ', ~Page ' + chunk.page_number : ''}]`;
      const excerpt = chunk.content.slice(0, 200);
      if ((contextText + label + chunk.content).length > MAX_CTX_CHARS) break;
      contextText += `\n${label}\n${chunk.content}\n`;
      sources.push({
        chunk_index: chunk.chunk_index,
        page_number: chunk.page_number,
        excerpt,
        similarity:  Math.round(chunk.similarity * 100) / 100,
      });
    }

    // ── 7. Call Gemini ──────────────────────────────────────────────────
    const systemPrompt = `You are an academic study assistant helping a student understand their own uploaded course notes and documents. 
Answer ONLY based on the document context provided below. 
If the answer is not in the context, say clearly: "I cannot find that information in this document."
Be concise, accurate, and educational. Use bullet points where helpful.
Do NOT make up information not present in the context.`;

    const userPrompt = `Document: "${resource.file_name}"

Relevant sections from the document:
${contextText.trim()}

Student's question: ${cleanQuestion}

Answer based only on the document content above:`;

    const geminiRes = await fetch(
      `${GEMINI_API_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
        }),
      },
    );

    if (geminiRes.status === 401 || geminiRes.status === 403) {
      return error(503, 'Gemini API key was rejected. Check the server-side GEMINI_API_KEY.');
    }
    if (geminiRes.status === 400) {
      const providerError = await geminiRes.json().catch(() => null);
      const providerMessage = providerError?.error?.message?.toLowerCase() ?? '';
      if (providerMessage.includes('api key') &&
          ['invalid', 'not valid', 'expired'].some((phrase) => providerMessage.includes(phrase))) {
        return error(503, 'Gemini API key was rejected. Check the server-side GEMINI_API_KEY.');
      }
    }
    if (geminiRes.status === 429) {
      return error(429, 'Gemini quota limit reached. Wait and try again, or check Google AI Studio usage limits.');
    }
    if (!geminiRes.ok) {
      console.error('Gemini API request failed with status:', geminiRes.status);
      return error(502, 'Gemini request failed. Please try again.');
    }

    const geminiData = await geminiRes.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const answer = geminiData.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!answer) return error(502, 'Gemini returned no answer. Please rephrase your question and try again.');

    // ── 8. Return result ─────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        success:   true,
        answer,
        sources,
        file_name: resource.file_name,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ask-document unhandled error:', msg);
    return error(500, msg);
  }
});

// ── Error response helper ──────────────────────────────────────────────────
function error(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
}
