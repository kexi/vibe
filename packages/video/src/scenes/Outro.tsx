import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { COLORS } from "../styles/colors";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 5秒版: より速いアニメーション
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  const installScale = spring({
    frame: frame - 20,
    fps,
    config: { damping: 15, stiffness: 150 },
  });

  const installOpacity = interpolate(frame, [20, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  const linksOpacity = interpolate(frame, [45, 55], [0, 1], {
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
      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          fontSize: 48,
          fontWeight: 700,
          color: COLORS.text,
          marginBottom: 48,
        }}
      >
        Get Started with vibe
      </div>

      {/* Install command */}
      <div
        style={{
          opacity: installOpacity,
          transform: `scale(${installScale})`,
          backgroundColor: COLORS.background,
          padding: "20px 40px",
          borderRadius: 12,
          marginBottom: 48,
        }}
      >
        <span style={{ color: COLORS.promptSymbol }}>❯ </span>
        <span style={{ color: COLORS.textBright }}>brew install kexi/tap/vibe</span>
      </div>

      {/* Links */}
      <div
        style={{
          opacity: linksOpacity,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            color: COLORS.text,
            fontSize: 24,
          }}
        >
          <span style={{ color: COLORS.textMuted }}>📦</span>
          <span>github.com/kexi/vibe</span>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          opacity: linksOpacity,
          color: COLORS.accent,
          fontSize: 32,
          fontWeight: 600,
        }}
      >
        vibe — git worktree helper
      </div>
    </div>
  );
};
