import React, { useMemo } from "react";
import { random } from "remotion";
import { C } from "./theme";

// A stylised 3D city in the app's dark map style: street grid, extruded buildings,
// and an orange route that can be drawn in (`draw` 0→1) and erased (`erase` 0→1).

const SIZE = 1400;
const CELL = 140;
const STREET = 26;

// Route along the street centre-lines (plane coordinates).
export const ROUTE: [number, number][] = [
  [420, 1330],
  [420, 840],
  [700, 840],
  [700, 560],
  [980, 560],
  [980, 280],
];

const routeLength = ROUTE.slice(1).reduce(
  (sum, p, i) => sum + Math.hypot(p[0] - ROUTE[i][0], p[1] - ROUTE[i][1]),
  0,
);

type Building = { x: number; y: number; w: number; d: number; h: number; tone: number };

const useBuildings = () =>
  useMemo(() => {
    const out: Building[] = [];
    for (let gx = 0; gx < SIZE / CELL; gx++) {
      for (let gy = 0; gy < SIZE / CELL; gy++) {
        const x0 = gx * CELL + STREET / 2 + 6;
        const y0 = gy * CELL + STREET / 2 + 6;
        const inner = CELL - STREET - 12;
        const split = random(`s${gx}-${gy}`) > 0.5;
        const parts = split ? 2 : 1;
        for (let i = 0; i < parts; i++) {
          const seed = `${gx}-${gy}-${i}`;
          const w = split ? inner / 2 - 4 : inner;
          out.push({
            x: x0 + (split ? i * (inner / 2 + 4) : 0),
            y: y0,
            w,
            d: inner,
            h: 12 + Math.pow(random(`h${seed}`), 2.4) * 105,
            tone: random(`t${seed}`),
          });
        }
      }
    }
    return out;
  }, []);

const Box: React.FC<{ b: Building }> = ({ b }) => {
  const top = `rgb(${46 + b.tone * 18}, ${48 + b.tone * 18}, ${56 + b.tone * 20})`;
  const side = `rgb(${30 + b.tone * 10}, ${31 + b.tone * 10}, ${37 + b.tone * 12})`;
  const front = `rgb(${24 + b.tone * 8}, ${25 + b.tone * 8}, ${30 + b.tone * 10})`;
  const face: React.CSSProperties = { position: "absolute" };
  return (
    <div
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.d,
        transformStyle: "preserve-3d",
      }}
    >
      <div style={{ ...face, inset: 0, background: top, transform: `translateZ(${b.h}px)` }} />
      {/* south face */}
      <div
        style={{
          ...face,
          left: 0,
          top: b.d,
          width: b.w,
          height: b.h,
          background: front,
          transformOrigin: "top",
          transform: "rotateX(90deg)",
        }}
      />
      {/* north face */}
      <div style={{ ...face, left: 0, top: -b.h, width: b.w, height: b.h, background: front, transformOrigin: "bottom", transform: "rotateX(-90deg)" }} />
      {/* west face */}
      <div style={{ ...face, left: -b.h, top: 0, width: b.h, height: b.d, background: side, transformOrigin: "right", transform: "rotateY(90deg)" }} />
      {/* east face */}
      <div
        style={{
          ...face,
          left: b.w,
          top: 0,
          width: b.h,
          height: b.d,
          background: side,
          transformOrigin: "left",
          transform: "rotateY(-90deg)",
        }}
      />
    </div>
  );
};

export const City: React.FC<{
  draw: number;
  erase?: number;
  rotate: number;
  tilt?: number;
  zoom?: number;
  showMarkers?: boolean;
  finishOnly?: boolean;
}> = ({ draw, erase = 0, rotate, tilt = 58, zoom = 1, showMarkers = true, finishOnly = false }) => {
  const buildings = useBuildings();
  const path = ROUTE.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
  const start = ROUTE[0];
  const end = ROUTE[ROUTE.length - 1];
  const routeOpacity = 1 - erase;
  const lines = [];
  for (let i = 0; i <= SIZE; i += CELL) lines.push(i);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        perspective: 1600,
        perspectiveOrigin: "50% 30%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: SIZE,
          height: SIZE,
          marginLeft: -SIZE / 2,
          marginTop: -SIZE / 2,
          transformStyle: "preserve-3d",
          transform: `scale(${zoom}) rotateX(${tilt}deg) rotateZ(${rotate}deg)`,
        }}
      >
        <svg width={SIZE} height={SIZE} style={{ position: "absolute", inset: 0 }}>
          <rect width={SIZE} height={SIZE} fill="#0e0e10" />
          {/* water on the west edge */}
          <path d={`M0 0 L150 0 Q120 500 190 820 Q230 1100 150 ${SIZE} L0 ${SIZE} Z`} fill="#0b1118" />
          {lines.map((v) => (
            <g key={v}>
              <line x1={v} y1={0} x2={v} y2={SIZE} stroke="#1c1d21" strokeWidth={STREET} />
              <line x1={0} y1={v} x2={SIZE} y2={v} stroke="#1c1d21" strokeWidth={STREET} />
            </g>
          ))}
          {/* a diagonal arterial for character */}
          <line x1={200} y1={1400} x2={1400} y2={200} stroke="#24262b" strokeWidth={34} />
          <line x1={200} y1={1400} x2={1400} y2={200} stroke="#2e3036" strokeWidth={4} strokeDasharray="30 30" />
          {!finishOnly && (
            <g opacity={routeOpacity}>
              <path d={path} fill="none" stroke="#000" strokeOpacity={0.6} strokeWidth={30} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={routeLength} strokeDashoffset={routeLength * (1 - draw)} />
              <path d={path} fill="none" stroke={C.accent} strokeWidth={16} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={routeLength} strokeDashoffset={routeLength * (1 - draw)} />
            </g>
          )}
        </svg>
        {buildings.map((b, i) => (
          <Box key={i} b={b} />
        ))}
        {showMarkers && (
          <>
            {!finishOnly && (
              <div
                style={{
                  position: "absolute",
                  left: start[0] - 22,
                  top: start[1] - 22,
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: C.text,
                  boxShadow: "0 0 0 12px rgba(242,242,239,.25)",
                  opacity: routeOpacity,
                  transform: "translateZ(2px)",
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: end[0] - 30,
                top: end[1] - 30,
                width: 60,
                height: 60,
                transformOrigin: "bottom",
                transform: `translateZ(130px) rotateX(-${tilt}deg) translateY(-30px)`,
                boxShadow: "0 10px 40px rgba(0,0,0,.7)",
                borderRadius: 10,
                border: `5px solid ${C.accent}`,
                background: "conic-gradient(#fff 25%, #111 0 50%, #fff 0 75%, #111 0) 0 0 / 25px 25px",
                opacity: finishOnly ? 1 : Math.min(routeOpacity, draw > 0.95 ? 1 : 0),
              }}
            />
          </>
        )}
      </div>
      {/* vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 55%, transparent 35%, ${C.bg} 85%)`,
        }}
      />
    </div>
  );
};
