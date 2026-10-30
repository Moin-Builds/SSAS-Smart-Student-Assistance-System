"""
Security and Isolation Tests:
Confirms that student data cannot leak across accounts.
"""

from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.auth import get_current_student


client = TestClient(app)


def test_unauthenticated_request_rejected():
    # Calling /api/process-document without Authorization header
    response = client.post("/api/process-document", json={"resource_id": "12345"})
    assert response.status_code == 403 or response.status_code == 401


def test_cross_student_access_denied():
    # Simulate Student A trying to process Student B's document
    student_a = {"id": "student-uuid-A", "email": "studenta@example.com"}

    app.dependency_overrides[get_current_student] = lambda: student_a

    with patch("backend.app.main.get_student_resource") as mock_get_resource:
        # Mock get_student_resource returning None because student_id doesn't match
        mock_get_resource.return_value = None

        response = client.post(
            "/api/process-document",
            json={"resource_id": "resource-of-student-b"}
        )

        assert response.status_code == 404
        assert "not found or access denied" in response.json()["detail"].lower()

    app.dependency_overrides.clear()
