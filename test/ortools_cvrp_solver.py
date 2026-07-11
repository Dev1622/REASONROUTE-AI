import json
import math
import sys
import time

from ortools.constraint_solver import pywrapcp, routing_enums_pb2


def read_payload():
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("Expected JSON payload on stdin.")
    return json.loads(raw)


def build_distance_matrix(nodes):
    coords = [(float(node["x"]), float(node["y"])) for node in nodes]
    matrix = []
    for ax, ay in coords:
        row = []
        for bx, by in coords:
            row.append(int(round(math.hypot(ax - bx, ay - by))))
        matrix.append(row)
    return matrix


def solve(payload):
    nodes = payload["nodes"]
    vehicle_count = int(payload["vehicleCount"])
    vehicle_capacity = int(payload["vehicleCapacity"])
    depot_index = int(payload.get("depotIndex", 0))
    time_limit_ms = max(1, int(payload.get("timeLimitMs", 1000)))
    first_solution = str(payload.get("firstSolutionStrategy", "PATH_CHEAPEST_ARC")).upper()
    local_search = str(payload.get("localSearchMetaheuristic", "GUIDED_LOCAL_SEARCH")).upper()

    distance_matrix = build_distance_matrix(nodes)
    demands = [int(node.get("demand", 0)) for node in nodes]
    capacities = [vehicle_capacity] * vehicle_count

    manager = pywrapcp.RoutingIndexManager(len(nodes), vehicle_count, depot_index)
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return distance_matrix[from_node][to_node]

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    def demand_callback(from_index):
        from_node = manager.IndexToNode(from_index)
        return demands[from_node]

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,
        capacities,
        True,
        "Capacity",
    )

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.time_limit.seconds = time_limit_ms // 1000
    search_parameters.time_limit.nanos = (time_limit_ms % 1000) * 1_000_000
    search_parameters.first_solution_strategy = getattr(
        routing_enums_pb2.FirstSolutionStrategy,
        first_solution,
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC,
    )
    search_parameters.local_search_metaheuristic = getattr(
        routing_enums_pb2.LocalSearchMetaheuristic,
        local_search,
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
    )
    search_parameters.log_search = bool(payload.get("logSearch", False))

    started = time.perf_counter()
    solution = routing.SolveWithParameters(search_parameters)
    elapsed_ms = (time.perf_counter() - started) * 1000.0

    if solution is None:
        return {
            "feasible": False,
            "runtimeMs": elapsed_ms,
            "routes": [],
            "totalCost": None,
            "status": "no_solution",
        }

    routes = []
    total_cost = 0
    for vehicle_id in range(vehicle_count):
        index = routing.Start(vehicle_id)
        route = []
        route_cost = 0
        while not routing.IsEnd(index):
            node_index = manager.IndexToNode(index)
            route.append(int(node_index))
            next_index = solution.Value(routing.NextVar(index))
            route_cost += routing.GetArcCostForVehicle(index, next_index, vehicle_id)
            index = next_index
        route.append(int(manager.IndexToNode(index)))
        routes.append(route)
        total_cost += route_cost

    return {
        "feasible": True,
        "runtimeMs": elapsed_ms,
        "routes": routes,
        "totalCost": int(total_cost),
        "status": "ok",
    }


def main():
    payload = read_payload()
    result = solve(payload)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
