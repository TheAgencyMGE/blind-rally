import React from "react";
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame } from "remotion";
import { City } from "./City";
import { BODY, C, DISPLAY, formatTime, loadFonts } from "./theme";

loadFonts();

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const out = Easing.bezier(0.16, 1, 0.3, 1);

// Timeline (30 fps)
export const T = {
  hook: [0, 105],
  logo: [105, 95],
  brief: [200, 240],
  erase: [440, 50],
  rally: [490, 160],
  reveal: [650, 180],
  features: [830, 128],
  end: [958, 92],
} as const;
export const TOTAL = 1050;

/** Fades a whole scene in and out over `f` frames. */
const Scene: React.FC<{ dur: number; children: React.ReactNode; f?: number }> = ({ dur, children, f = 8 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, f, dur - f, dur], [0, 1, 1, 0], clamp) }}>
      {children}
    </AbsoluteFill>
  );
};

const Center: React.FC<{ children: React.ReactNode; gap?: number; style?: React.CSSProperties }> = ({ children, gap = 24, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap, ...style }}>
    {children}
  </AbsoluteFill>
);

const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties; dist?: number }> = ({ at, children, style, dist = 40 }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        opacity: interpolate(frame, [at, at + 12], [0, 1], clamp),
        translate: `0 ${interpolate(frame, [at, at + 20], [dist, 0], { ...clamp, easing: out })}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const big = (size: number, color = C.text): React.CSSProperties => ({
  fontFamily: DISPLAY,
  fontWeight: 800,
  fontSize: size,
  lineHeight: 0.9,
  textTransform: "uppercase",
  color,
  margin: 0,
  letterSpacing: "-0.005em",
});

const label = (size = 34, color = C.muted): React.CSSProperties => ({
  fontFamily: DISPLAY,
  fontWeight: 700,
  fontSize: size,
  letterSpacing: "0.2em",
  textTransform: "uppercase",
  color,
  margin: 0,
});

// ---------------------------------------------------------------- 1. hook

const Hook: React.FC = () => {
  return (
    <Scene dur={T.hook[1]}>
      <Center gap={10}>
        <Rise at={4}>
          <p style={big(150)}>
            You get <span style={{ color: C.accent }}>15</span> seconds
          </p>
        </Rise>
        <Rise at={34}>
          <p style={{ ...big(150, C.muted) }}>to learn the route.</p>
        </Rise>
        <Rise at={64}>
          <p style={{ ...label(40, C.text), marginTop: 40 }}>Then it disappears.</p>
        </Rise>
      </Center>
    </Scene>
  );
};

// ---------------------------------------------------------------- 2. logo

const Logo: React.FC<{ dur: number; withUrl?: boolean }> = ({ dur, withUrl }) => {
  const frame = useCurrentFrame();
  return (
    <Scene dur={dur}>
      <Center gap={0}>
        <div style={{ scale: interpolate(frame, [0, 14], [1.25, 1], { ...clamp, easing: out }), textAlign: "left" }}>
          <p style={big(250)}>Blind</p>
          <p style={big(250, C.accent)}>Rally</p>
        </div>
        <Rise at={18}>
          <p style={{ fontFamily: BODY, fontSize: 46, color: C.muted, margin: "40px 0 0" }}>
            Know the route. Not the destination.
          </p>
        </Rise>
        {withUrl && (
          <Rise at={32}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 70 }}>
              <p style={{ ...label(40, C.text), letterSpacing: "0.08em", textTransform: "none" }}>theagencymge.github.io/blind-rally</p>
              <p style={{ ...label(30) }}>Free · Open source · No account</p>
            </div>
          </Rise>
        )}
      </Center>
    </Scene>
  );
};

// ---------------------------------------------------------------- 3. briefing

const STEPS: { icon: string; street: string; dist: string }[] = [
  { icon: "↑", street: "Pike St", dist: "490 m" },
  { icon: "→", street: "1st Ave", dist: "280 m" },
  { icon: "↑", street: "Bell St", dist: "280 m" },
  { icon: "→", street: "Western Ave", dist: "280 m" },
  { icon: "↑", street: "Vine St", dist: "280 m" },
  { icon: "⚑", street: "", dist: "" },
];

const Ring: React.FC<{ left: number; total: number; size?: number }> = ({ left, total, size = 170 }) => {
  const r = 44;
  const len = 2 * Math.PI * r;
  const urgent = left <= 5;
  const col = urgent ? C.danger : C.accent;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ rotate: "-90deg" }}>
        <circle cx={50} cy={50} r={r} fill="rgba(10,10,11,.8)" stroke={C.line} strokeWidth={6} />
        <circle cx={50} cy={50} r={r} fill="none" stroke={col} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - left / total)} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", ...big(size * 0.44, urgent ? C.danger : C.text) }}>
        {Math.ceil(left)}
      </div>
    </div>
  );
};

const Briefing: React.FC = () => {
  const frame = useCurrentFrame();
  const dur = T.brief[1];
  const left = interpolate(frame, [10, dur], [15, 0], clamp);
  return (
    <Scene dur={dur} f={6}>
      <City
        draw={interpolate(frame, [12, 90], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) })}
        rotate={interpolate(frame, [0, dur], [-18, -4])}
        zoom={interpolate(frame, [0, dur], [1.05, 1.18])}
      />
      {/* HUD */}
      <AbsoluteFill style={{ padding: 70, flexDirection: "row", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <Ring left={left} total={15} />
          <Rise at={6}>
            <p style={big(64)}>1.6 km</p>
            <p style={{ ...big(40, C.muted), marginTop: 6 }}>21 min</p>
          </Rise>
        </div>
        <div
          style={{
            width: 640,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 10,
            padding: "30px 40px",
            background: "linear-gradient(90deg, transparent, rgba(10,10,11,.92) 22%)",
            marginRight: -70,
            paddingLeft: 120,
          }}
        >
          {STEPS.map((s, i) => (
            <Rise key={i} at={24 + i * 9} dist={20}>
              <div style={{ display: "grid", gridTemplateColumns: "56px 1fr auto", alignItems: "center", gap: 20, height: 74 }}>
                <span style={{ fontSize: 44, color: C.accent, fontFamily: BODY, textAlign: "center" }}>{s.icon}</span>
                <span style={{ fontFamily: BODY, fontWeight: 600, fontSize: 38, color: C.text }}>{s.street}</span>
                <span style={{ ...big(38, C.muted), fontWeight: 700 }}>{s.dist}</span>
              </div>
            </Rise>
          ))}
        </div>
      </AbsoluteFill>
      <Sequence from={0} durationInFrames={70} layout="none">
        <Center style={{ justifyContent: "flex-end", paddingBottom: 90 }}>
          <Rise at={4}>
            <p style={{ ...big(120), textShadow: "0 6px 40px #000" }}>Memorize.</p>
          </Rise>
        </Center>
      </Sequence>
    </Scene>
  );
};

// ---------------------------------------------------------------- 4. erase

const Erase: React.FC = () => {
  const frame = useCurrentFrame();
  const dur = T.erase[1];
  return (
    <Scene dur={dur} f={4}>
      <div style={{ position: "absolute", inset: 0, opacity: interpolate(frame, [4, 18], [1, 0], clamp) }}>
        <City draw={1} erase={interpolate(frame, [0, 6], [0, 1], clamp)} rotate={-4} zoom={1.18} />
      </div>
      {/* scanline wipe */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 6,
          background: C.danger,
          boxShadow: `0 0 60px 20px ${C.danger}55`,
          top: `${interpolate(frame, [0, 14], [-2, 102], clamp)}%`,
        }}
      />
      <Center>
        <Rise at={16} dist={0}>
          <p style={{ ...big(200), scale: interpolate(frame, [16, 40], [1.1, 1], clamp) }}>Gone.</p>
        </Rise>
      </Center>
    </Scene>
  );
};

// ---------------------------------------------------------------- 5. rally

const Rally: React.FC = () => {
  const frame = useCurrentFrame();
  const dur = T.rally[1];
  // Time-lapse the stage clock: real seconds early on, then racing ahead.
  const ms = interpolate(frame, [0, 40, dur], [0, 4000, 521_300], { ...clamp, easing: Easing.in(Easing.quad) });
  const pulse = 1 + 0.06 * Math.sin(frame / 5);
  return (
    <Scene dur={dur}>
      <AbsoluteFill style={{ padding: "70px 90px", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontFamily: BODY, fontSize: 54, color: C.muted }}>✕</span>
        <span style={{ display: "flex", alignItems: "center", gap: 16, ...big(40, C.muted), fontWeight: 700 }}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", background: C.ok, scale: pulse }} />±6 m
        </span>
      </AbsoluteFill>
      <Center gap={50}>
        <p style={{ ...big(340), fontVariantNumeric: "tabular-nums" }}>{formatTime(ms)}</p>
        <div
          style={{
            width: 190,
            height: 190,
            borderRadius: "50%",
            border: `4px solid ${C.accent}`,
            display: "grid",
            placeItems: "center",
            color: C.accent,
            fontSize: 80,
            fontFamily: BODY,
          }}
        >
          ⚑
        </div>
      </Center>
      <Sequence from={22} durationInFrames={70} layout="none">
        <Center style={{ justifyContent: "flex-start", paddingTop: 150 }}>
          <Rise at={0}>
            <p style={label(44, C.text)}>No map. No hints.</p>
          </Rise>
        </Center>
      </Sequence>
      <Sequence from={92} durationInFrames={dur - 92} layout="none">
        <Center style={{ justifyContent: "flex-start", paddingTop: 150 }}>
          <Rise at={0}>
            <p style={label(44, C.accent)}>Just memory.</p>
          </Rise>
        </Center>
      </Sequence>
    </Scene>
  );
};

// ---------------------------------------------------------------- 6. reveal

const Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  const dur = T.reveal[1];
  const time = 521_300;
  return (
    <Scene dur={dur}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.85 }}>
        <City draw={0} finishOnly rotate={interpolate(frame, [0, dur], [10, 40])} zoom={interpolate(frame, [0, dur], [1.5, 1.7])} tilt={60} />
      </div>
      <AbsoluteFill style={{ background: `linear-gradient(90deg, ${C.bg} 30%, transparent 75%)` }} />
      <AbsoluteFill style={{ padding: "0 140px", justifyContent: "center", gap: 18 }}>
        <Rise at={6}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <span
              style={{
                width: 70,
                height: 48,
                background: "conic-gradient(#fff 25%, transparent 0 50%, #fff 0 75%, transparent 0) 0 0 / 24px 24px",
                transform: `skewY(${Math.sin(frame / 6) * 6}deg)`,
              }}
            />
            <p style={label(40, C.accent)}>Destination discovered</p>
          </div>
        </Rise>
        <Rise at={20}>
          <p style={{ ...label(36), marginTop: 20 }}>Viewpoint</p>
          <p style={big(170)}>Kerry Park</p>
        </Rise>
        <Rise at={40}>
          <p style={{ ...big(220, C.accent), fontVariantNumeric: "tabular-nums", marginTop: 20 }}>
            {formatTime(interpolate(frame, [40, 80], [0, time], { ...clamp, easing: out }))}
          </p>
        </Rise>
        <Rise at={84}>
          <p style={big(64, C.ok)}>New PB · −0:31.4</p>
        </Rise>
      </AbsoluteFill>
    </Scene>
  );
};

// ---------------------------------------------------------------- 7. features

const FEATURES: [string, string][] = [
  ["3D maps", "Tilted, extruded, easy to read."],
  ["Walk or drive", "Rookie 60s · Pro 30s · Insane 15s"],
  ["Real places", "Parks, plazas, viewpoints, scenic roads."],
  ["Zero accounts", "Free. Open source. Runs in your browser."],
];

const Features: React.FC = () => {
  const frame = useCurrentFrame();
  const each = T.features[1] / FEATURES.length;
  const i = Math.min(FEATURES.length - 1, Math.floor(frame / each));
  const local = frame - i * each;
  const [title, sub] = FEATURES[i];
  return (
    <Scene dur={T.features[1]} f={6}>
      <Center gap={26}>
        <p style={{ ...label(32, C.accent) }}>{`0${i + 1}`}</p>
        <p
          style={{
            ...big(200),
            opacity: interpolate(local, [0, 6, each - 5, each], [0, 1, 1, 0], clamp),
            translate: `0 ${interpolate(local, [0, 12], [30, 0], { ...clamp, easing: out })}px`,
          }}
        >
          {title}
        </p>
        <p style={{ fontFamily: BODY, fontSize: 48, color: C.muted, margin: 0, opacity: interpolate(local, [4, 12, each - 5, each], [0, 1, 1, 0], clamp) }}>
          {sub}
        </p>
      </Center>
    </Scene>
  );
};

// ---------------------------------------------------------------- root

export const BlindRally: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Sequence name="Hook" from={T.hook[0]} durationInFrames={T.hook[1]}>
        <Hook />
      </Sequence>
      <Sequence name="Logo" from={T.logo[0]} durationInFrames={T.logo[1]}>
        <Logo dur={T.logo[1]} />
      </Sequence>
      <Sequence name="Briefing" from={T.brief[0]} durationInFrames={T.brief[1]}>
        <Briefing />
      </Sequence>
      <Sequence name="Erase" from={T.erase[0]} durationInFrames={T.erase[1]}>
        <Erase />
      </Sequence>
      <Sequence name="Rally" from={T.rally[0]} durationInFrames={T.rally[1]}>
        <Rally />
      </Sequence>
      <Sequence name="Reveal" from={T.reveal[0]} durationInFrames={T.reveal[1]}>
        <Reveal />
      </Sequence>
      <Sequence name="Features" from={T.features[0]} durationInFrames={T.features[1]}>
        <Features />
      </Sequence>
      <Sequence name="End" from={T.end[0]} durationInFrames={T.end[1]}>
        <Logo dur={T.end[1]} withUrl />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- README banner (still)

export const Banner: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <div style={{ position: "absolute", inset: 0, left: 380, opacity: 0.9 }}>
      <City draw={1} rotate={-10} zoom={0.95} />
    </div>
    <AbsoluteFill style={{ background: `linear-gradient(90deg, ${C.bg} 38%, transparent 80%)` }} />
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 90px", gap: 26 }}>
      <div>
        <p style={big(170)}>Blind</p>
        <p style={big(170, C.accent)}>Rally</p>
      </div>
      <p style={{ fontFamily: BODY, fontSize: 36, color: C.muted, margin: 0 }}>Know the route. Not the destination.</p>
    </AbsoluteFill>
  </AbsoluteFill>
);
