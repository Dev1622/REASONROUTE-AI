import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { OptimizationResult } from '../types';

interface MapVisualizationProps {
  data: OptimizationResult | null;
  loading: boolean;
}

const MapVisualization: React.FC<MapVisualizationProps> = ({ data, loading }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !data) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove(); // Clear previous render

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    
    // Scale 0-100 coordinates to SVG dimensions with padding
    const padding = 50;
    const xScale = d3.scaleLinear().domain([0, 100]).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain([0, 100]).range([height - padding, padding]); // Invert Y for map logic

    // --- 1. Draw Disruptions ---
    if (data.disruptions) {
      svg.selectAll(".disruption")
        .data(data.disruptions)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", d => d.radius * (width / 100)) // Scale radius roughly
        .attr("fill", "rgba(239, 68, 68, 0.2)") // Red-500 with opacity
        .attr("stroke", "#ef4444")
        .attr("stroke-dasharray", "4 2")
        .attr("class", "animate-pulse");
      
      svg.selectAll(".disruption-label")
        .data(data.disruptions)
        .enter()
        .append("text")
        .attr("x", d => xScale(d.x))
        .attr("y", d => yScale(d.y) - (d.radius * (width/100)) - 5)
        .text(d => d.description)
        .attr("text-anchor", "middle")
        .attr("fill", "#ef4444")
        .attr("font-size", "10px")
        .attr("font-family", "monospace");
    }

    // --- 2. Draw Baseline Route (Gray) ---
    const baselineLine = d3.line<string>()
      .x(id => {
        const node = data.nodes.find(n => n.id === id);
        return node ? xScale(node.x) : 0;
      })
      .y(id => {
        const node = data.nodes.find(n => n.id === id);
        return node ? yScale(node.y) : 0;
      })
      .curve(d3.curveLinear);

    svg.append("path")
      .datum(data.baselinePath)
      .attr("fill", "none")
      .attr("stroke", "#475569") // Slate-600
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "5,5")
      .attr("d", baselineLine)
      .attr("opacity", 0.6);

    // --- 3. Draw Optimized Route (Green) ---
    // Use a slightly curved interpolation for "smart" feel
    const optimizedLine = d3.line<string>()
      .x(id => {
        const node = data.nodes.find(n => n.id === id);
        return node ? xScale(node.x) : 0;
      })
      .y(id => {
        const node = data.nodes.find(n => n.id === id);
        return node ? yScale(node.y) : 0;
      })
      .curve(d3.curveCatmullRom.alpha(0.5));

    const path = svg.append("path")
      .datum(data.optimizedPath)
      .attr("fill", "none")
      .attr("stroke", "#10b981") // Emerald-500
      .attr("stroke-width", 3)
      .attr("d", optimizedLine);
    
    // Animate the optimized path
    const totalLength = path.node()?.getTotalLength() || 0;
    path
      .attr("stroke-dasharray", totalLength + " " + totalLength)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(2000)
      .ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    // --- 4. Draw Nodes ---
    const nodes = svg.selectAll(".node")
      .data(data.nodes)
      .enter()
      .append("g")
      .attr("transform", d => `translate(${xScale(d.x)}, ${yScale(d.y)})`);

    // Node Circles
    nodes.append("circle")
      .attr("r", d => d.type === 'hub' ? 8 : 5)
      .attr("fill", d => d.type === 'hub' ? "#3b82f6" : "#e2e8f0") // Blue for Hub, Slate for Stop
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 2);

    // Node Labels
    nodes.append("text")
      .attr("dy", -12)
      .text(d => d.label)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .attr("font-size", "10px")
      .attr("font-family", "sans-serif");

  }, [data]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-slate-900 text-slate-400">
        <div className="w-16 h-16 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-4"></div>
        <p className="font-mono text-sm animate-pulse">Running Spatial-Reasoning Framework...</p>
        <p className="text-xs text-slate-600 mt-2">Pattern Detection • Context Override • Recursive Solve</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-slate-900/50 text-slate-500">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 7m0 13V7" />
          </svg>
          <p className="font-mono text-sm">Awaiting Inputs to Initialize Graph</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-slate-900 rounded-lg overflow-hidden shadow-2xl border border-slate-800">
      <div className="absolute top-4 right-4 flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-2">
          <div className="w-4 h-1 bg-slate-500 opacity-60"></div>
          <span className="text-xs text-slate-400 font-mono">Baseline</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-1 bg-emerald-500"></div>
          <span className="text-xs text-emerald-400 font-mono">Optimized</span>
        </div>
        {data.disruptions && data.disruptions.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500/30 border border-red-500"></div>
            <span className="text-xs text-red-400 font-mono">Disruption</span>
          </div>
        )}
      </div>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
};

export default MapVisualization;
