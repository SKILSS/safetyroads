# SafetyRoad v9 fixes

- Fixed report-card swipe deletion with Pointer Events, so it works on touchscreens, trackpads, and desktop mouse dragging.
- The red X is a real button revealed after a right swipe and opens the bilingual confirmation dialog.
- Fixed the modular admin event wiring so report/fix buttons are not accidentally overwritten by admin handlers.
- When DeepSeek accepts a repair photo, the report immediately changes to `resolved`, disappears from map markers and public problem lists, and is excluded from navigator road-quality calculations.
- If a route is already displayed when a report is resolved or withdrawn, the navigator invalidates its road-problem cache and rebuilds the route using only active reports.
- Periodic problem refreshes also detect resolved/withdrawn reports and refresh the navigator automatically.
- Status filtering is case-insensitive for `rejected`, `withdrawn`, and `resolved`.
