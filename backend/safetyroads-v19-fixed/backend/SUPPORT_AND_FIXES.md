# SafetyRoad — support and problem-source model

- Added a dedicated Support tab powered by Gemini.
- Support chat is available without signing in; the API remains rate-limited and the Gemini key stays server-side.
- Support chat sends recent conversation history so Gemini can answer follow-up questions.
- Problems are split logically by `source_type`:
  - `user` — created by a signed-in user and shown in that user's profile only.
  - `osm`, `rss`, and other external values — shared SafetyRoad data with `created_by = NULL`; visible on the public map but never copied into a user's profile.
- `/api/problems` is the shared public map dataset.
- `/api/problems/my` is the profile dataset and returns only the current user's own reports.
- Imported external reports remain database records even after they are resolved; their public map visibility is controlled by `status`.
- The map uses the red `!` problem marker. Its popup identifies whether the report is shared external data or user-submitted data.
- The `❓` / fix button sends the visitor to Settings and opens the Gemini repair-photo flow.
- Repair evidence can be submitted without signing in. If Gemini returns `isFixed=true` with confidence >= 0.80, the report is immediately marked `resolved` and disappears from the shared map for everyone on the next refresh.
- A negative/ambiguous Gemini result leaves the problem active.
- User-created reports can still be withdrawn by their owner; withdrawn reports remain in the database for history/audit.
