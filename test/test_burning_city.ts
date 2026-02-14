// test_burning_city.ts
import { runReasonRouteEngine, EngineInput } from "./../services/reasonRouteEngine"; // Adjust path if needed

// --- THE BURNING CITY PAYLOAD (Hardcoded) ---
const BURNING_CITY_INPUT: EngineInput = {
  "nodes": [
    { "id": "DEPOT", "x": 0, "y": 0, "type": "depot" },
    // DOWNTOWN (Safe)
    { "id": "Stop_1", "x": 1, "y": 2, "type": "stop" },
    { "id": "Stop_2", "x": 1.2, "y": 2.1, "type": "stop" },
    { "id": "Stop_3", "x": 0.8, "y": 1.9, "type": "stop" },
    { "id": "Stop_4", "x": 1.5, "y": 2.5, "type": "stop" },
    // NORTH HUB (Destination)
    { "id": "Hub_North", "x": 9, "y": 9, "type": "stop" },
    { "id": "Stop_5", "x": 8.5, "y": 8.5, "type": "stop" },
    { "id": "Stop_6", "x": 9.2, "y": 9.1, "type": "stop" },
    { "id": "Stop_7", "x": 8.8, "y": 8.2, "type": "stop" },
    // THE TRAP (Gridlock/Fire)
    { "id": "Trap_A", "x": 5, "y": 5, "type": "stop" },
    { "id": "Trap_B", "x": 5.2, "y": 5.2, "type": "stop" }
  ],
  "depotId": "DEPOT",
  "constraints": [],
  "preferences": {
    "weightTime": 1.0,
    "weightEmissions": 0.0,
    "weightDistance": 0.0
  },
  // --- THE HEATMAP IS HERE (Inside the JSON) ---
  "trafficHeatmap": [
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.1, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.1, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.5, 0.9, 0.9, 0.5, 0.0, 0.0, 0.0], // FIRE
    [0.0, 0.0, 0.0, 0.5, 0.9, 0.9, 0.5, 0.0, 0.0, 0.0], // FIRE
    [0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1],
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1]
  ]
};

// --- RUN THE TEST ---
console.log("\n🔥 RUNNING BURNING CITY TEST...");
const result = runReasonRouteEngine(BURNING_CITY_INPUT);

console.log("\n📊 RESULTS:");
console.log("------------------------------------------------");
console.log(`BASELINE Path:  ${result.metrics.baseline.distance.toFixed(2)} km | ${result.metrics.baseline.time.toFixed(1)} min`);
console.log(`OPTIMIZED Path: ${result.metrics.optimized.distance.toFixed(2)} km | ${result.metrics.optimized.time.toFixed(1)} min`);

console.log("\n🛑 SKIPPED NODES (Traps):");
console.log(result.skippedNodes);

// VERIFICATION CHECK
if (result.skippedNodes.includes("Trap_A") && result.skippedNodes.includes("Trap_B")) {
    console.log("\n✅ SUCCESS: The engine detected the fire and removed the trap nodes.");
} else {
    console.log("\n❌ FAILURE: The engine drove through the fire.");
}

if (result.metrics.optimized.time < result.metrics.baseline.time) {
    console.log("✅ SUCCESS: Optimized route is faster than baseline.");
} else {
    console.log("❌ FAILURE: Optimized route is not faster.");
}