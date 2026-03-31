import java.util.*;

class Stop {
    int id;
    double x, y;

    Stop(int id, double x, double y) {
        this.id = id;
        this.x = x;
        this.y = y;
    }
}

public class test {

    public static void main(String[] args) {
        List<Stop> stops = new ArrayList<>();
        Random rand = new Random(42);

        int id = 1;

        // 🔹 5 Major Clusters (100 stops each)
        double[][] centers = {
            {20, 80}, {80, 80}, {20, 20}, {80, 20}, {50, 50}
        };

        for (double[] center : centers) {
            for (int i = 0; i < 100; i++) {
                double x = center[0] + rand.nextGaussian() * 5;
                double y = center[1] + rand.nextGaussian() * 5;
                stops.add(new Stop(id++, x, y));
            }
        }

        // 🔹 20 Outliers (spread randomly)
        for (int i = 0; i < 20; i++) {
            double x = rand.nextDouble() * 100;
            double y = rand.nextDouble() * 100;
            stops.add(new Stop(id++, x, y));
        }

        // Print JSON
        System.out.println("{ \"depot\": {\"x\":50,\"y\":50}, \"stops\": [");

        for (Stop s : stops) {
            System.out.println("{\"id\":" + s.id + ",\"x\":" + s.x + ",\"y\":" + s.y + "},");
        }

        System.out.println("]}");
    }
}