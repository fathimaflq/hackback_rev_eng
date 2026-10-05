# API Reference — Smart Slot Booking

**Status**: Proposed / Planning Phase  
> All endpoints described here are **proposed**. They have not yet been implemented.

Base URL (proposed): `http://localhost:3000/api`

---

## 1. `GET /api/slots`

**Purpose**: Return available faculty slots for a given faculty member, date, and duration.

### Request

| Parameter | Location | Type | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| `facultyId` | Query | String | Yes | ID of the faculty member |
| `date` | Query | String (YYYY-MM-DD) | Yes | Date to check availability for |
| `duration` | Query | Integer (minutes) | Yes | Desired appointment duration |

**Example**:
```
GET /api/slots?facultyId=clx123&date=2026-10-09&duration=30
```

### Response — `200 OK`

```json
{
  "facultyId": "clx123",
  "date": "2026-10-09",
  "duration": 30,
  "availableSlots": [
    { "startTime": "2026-10-09T09:00:00Z", "endTime": "2026-10-09T09:30:00Z" },
    { "startTime": "2026-10-09T10:00:00Z", "endTime": "2026-10-09T10:30:00Z" }
  ]
}
```

### Error Responses

| Status | Condition |
| :--- | :--- |
| `400 Bad Request` | Missing or invalid query parameters |
| `404 Not Found` | Faculty not found |
| `500 Internal Server Error` | Unexpected server error |

---

## 2. `POST /api/smart-booking`

**Purpose**: Accept a natural-language booking request from a student, parse it into structured filters, and return matching available slots.

> **Important**: This endpoint only parses the request and returns available slots. It does **not** create a booking. The student must explicitly confirm via `POST /api/bookings`.

### Request Body

```json
{
  "text": "I need 30 mins with Prof. Rao sometime Thursday afternoon"
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `text` | String | Yes | Free-text booking request from the student |

### Response — `200 OK`

```json
{
  "parsedFilters": {
    "faculty": "Prof. Rao",
    "duration": 30,
    "day": "Thursday",
    "timeRange": "afternoon"
  },
  "availableSlots": [
    {
      "facultyId": "clx123",
      "facultyName": "Prof. Rao",
      "startTime": "2026-10-09T13:00:00Z",
      "endTime": "2026-10-09T13:30:00Z"
    }
  ]
}
```

| Field | Description |
| :--- | :--- |
| `parsedFilters` | Structured filters extracted by the NL parser |
| `availableSlots` | Slots from the Availability Service matching the parsed filters |

### Error Responses

| Status | Condition |
| :--- | :--- |
| `400 Bad Request` | `text` field missing or empty |
| `422 Unprocessable Entity` | Parser could not extract required fields (e.g., faculty name not found) |
| `500 Internal Server Error` | Unexpected server error |

---

## 3. `POST /api/bookings`

**Purpose**: Create a booking using the concurrency-safe booking flow. Exactly one booking succeeds when two simultaneous requests target the same slot.

### Request Body

```json
{
  "facultyId": "clx123",
  "startTime": "2026-10-09T13:00:00Z",
  "endTime": "2026-10-09T13:30:00Z",
  "idempotencyKey": "student-abc-slot-xyz-001"
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `facultyId` | String | Yes | ID of the faculty member to book |
| `startTime` | String (ISO 8601 UTC) | Yes | Booking start time |
| `endTime` | String (ISO 8601 UTC) | Yes | Booking end time |
| `idempotencyKey` | String | Recommended | Prevents duplicate bookings from client retries |

### Response — `201 Created`

```json
{
  "bookingId": "clbk456",
  "facultyId": "clx123",
  "studentId": "clstu789",
  "startTime": "2026-10-09T13:00:00Z",
  "endTime": "2026-10-09T13:30:00Z",
  "status": "CONFIRMED"
}
```

### Error Responses

| Status | Condition |
| :--- | :--- |
| `400 Bad Request` | Missing or invalid fields |
| `409 Conflict` | Slot is already taken (returned to the losing concurrent request) |
| `500 Internal Server Error` | Unexpected server error |

> **Note on 409**: When two simultaneous requests target the same slot, exactly one receives `201 Created` and the other receives `409 Conflict`. The `409` is the expected and correct response for the losing request.

---

## 4. `POST /api/bookings/:id/release`

**Purpose**: Release (cancel) a student's booking, making the slot available for other students.

### URL Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `id` | String | ID of the booking to release |

### Request Body

```json
{
  "reason": "Cannot attend"
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `reason` | String | No | Optional reason for releasing the slot |

### Response — `200 OK`

```json
{
  "bookingId": "clbk456",
  "status": "CANCELLED",
  "message": "Slot released successfully. It is now available for other students."
}
```

### Error Responses

| Status | Condition |
| :--- | :--- |
| `404 Not Found` | Booking not found |
| `403 Forbidden` | Requesting student does not own the booking |
| `400 Bad Request` | Booking is already cancelled or completed |
| `500 Internal Server Error` | Unexpected server error |

---

## 5. `GET /api/bookings/history`

**Purpose**: Return a student's booking history, including no-show records used for the smart reminder logic.

### Request

No body required. Student identity is determined from the authenticated session.

Optional query parameters:

| Parameter | Location | Type | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| `status` | Query | String | No | Filter by booking status (e.g., `NO_SHOW`, `COMPLETED`) |
| `limit` | Query | Integer | No | Maximum number of records to return |

**Example**:
```
GET /api/bookings/history?status=NO_SHOW
```

### Response — `200 OK`

```json
{
  "studentId": "clstu789",
  "noShowCount": 2,
  "bookings": [
    {
      "bookingId": "clbk001",
      "facultyId": "clx123",
      "startTime": "2026-09-15T09:00:00Z",
      "endTime": "2026-09-15T09:30:00Z",
      "status": "NO_SHOW"
    },
    {
      "bookingId": "clbk002",
      "facultyId": "clx456",
      "startTime": "2026-09-22T14:00:00Z",
      "endTime": "2026-09-22T14:30:00Z",
      "status": "COMPLETED"
    }
  ]
}
```

### Error Responses

| Status | Condition |
| :--- | :--- |
| `401 Unauthorized` | Student not authenticated |
| `500 Internal Server Error` | Unexpected server error |
