# UI Test Pack: Context-Aware Spatial Reasoning

This pack is designed for your product goal only:
- validate context-aware rerouting
- validate spatial reasoning under disruptions
- ignore BKS-style benchmarking

Use in UI:
1. Copy a case `*_stops.csv` into the stops textarea.
2. Upload the matching `*_heatmap.svg` (if provided).
3. Click `OPTIMIZE ROUTE`.
4. Record:
- baseline vs optimized metrics
- `engineLogs` stage lines
- visible path behavior on map

Pass criteria are qualitative by behavior, not strict distance targets.

## Cases

### Case 1: Control (No Context)
Files:
- `case1_control_stops.csv`

Run:
- No image upload.

Expect:
- Baseline and optimized can be equal or near-equal.
- No trap removal.

---

### Case 2: Hard Trap Removal
Files:
- `case2_hard_trap_stops.csv`
- `case2_hard_trap_heatmap.svg`

Expect:
- Central `Trap_A` / `Trap_B` region should be avoided or removed.
- Logs should show non-zero trap removal in Stage 2 for many runs.
- Optimized path should route around center hotspot.

---

### Case 3: Soft Detour Around Congested Band
Files:
- `case3_soft_congestion_stops.csv`
- `case3_soft_congestion_heatmap.svg`

Expect:
- Route should avoid top corridor band where possible.
- Even when distance rises slightly, time/composite should improve or hold.

---

### Case 4: Two Clusters With Narrow Safe Bridge
Files:
- `case4_bridge_corridor_stops.csv`
- `case4_bridge_corridor_heatmap.svg`

Expect:
- Solver should use the visible middle bridge corridor.
- Fewer chaotic cross-cluster jumps.
- Strong context-driven structure in final path.

---

### Case 5: Scale Stress (240 Stops)
Files:
- `case5_scale_240_stops.csv`
- `case5_scale_heatmap.svg`

Expect:
- Completion should remain fast.
- Optimized route should visibly avoid the marked disruption regions.
- Logs should still show context/pattern processing.

## Notes

- Your current UI converts JSON uploads to plain CSV stops and discards constraints/heatmap JSON.
- This pack therefore uses image context (`.svg`) for UI-compatible testing.
- Keep focus on behavior under context, not on CVRPLIB BKS distance gaps.
