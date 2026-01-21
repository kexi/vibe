import React from "react";
import {
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
} from "remotion";
import { COLORS } from "../styles/colors";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 3秒版: より速いアニメーション
  const logoScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 150 },
  });

  const logoOpacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [20, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineY = interpolate(frame, [20, 35], [20, 0], {
    extrapolateRight: "clamp",
  });

  const promptOpacity = interpolate(frame, [40, 50], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#0a0a0f",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "SF Mono, Menlo, Monaco, monospace",
      }}
    >
      {/* Logo */}
      <div
        style={{
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
        }}
      >
        <div
          style={{
            fontSize: 120,
            fontWeight: 700,
            color: COLORS.accent,
            letterSpacing: -4,
          }}
        >
          vibe
        </div>
      </div>

      {/* Tagline */}
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          marginTop: 24,
        }}
      >
        <div
          style={{
            fontSize: 32,
            color: COLORS.textMuted,
          }}
        >
          super fast ⚡ git worktree helper
        </div>
      </div>

      {/* Decorative terminal prompt */}
      <div
        style={{
          opacity: promptOpacity,
          marginTop: 60,
          padding: "12px 24px",
          backgroundColor: COLORS.background,
          borderRadius: 8,
        }}
      >
        <span style={{ color: COLORS.promptSymbol }}>❯ </span>
        <span style={{ color: COLORS.textBright }}>vibe start feat/new-ui</span>
      </div>
    </div>
  );
};
