import React from "react";
import { useCurrentFrame } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const VerifyCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 40;
  const outputStartFrame = 55;

  // 実際のvibe verifyの出力形式に合わせる
  const outputLines = [
    { text: "", delay: 0 },
    { text: "=== Vibe Configuration Verification ===", color: COLORS.accent },
    { text: "", delay: 6 },
    { text: "File: .vibe.toml", color: COLORS.text, delay: 9 },
    {
      text: "Path: /Users/kei/ghq/github.com/kexi/vibe/.vibe.toml",
      color: COLORS.textMuted,
      delay: 12,
    },
    { text: "Repository: github.com/kexi/vibe", color: COLORS.textMuted, delay: 15 },
    { text: "Relative Path: .vibe.toml", color: COLORS.textMuted, delay: 18 },
    { text: "Status: ✅ TRUSTED", color: COLORS.success, delay: 21 },
    { text: "Current Hash: matches stored hash", color: COLORS.textMuted, delay: 24 },
    { text: "", delay: 27 },
    { text: "Hash History (3 stored):", color: COLORS.text, delay: 30 },
    { text: "  1. 5ff6c8bd63cabcca...", color: COLORS.textMuted, delay: 33 },
    { text: "  2. d0e00a12d3d0b7a8...", color: COLORS.textMuted, delay: 36 },
    { text: "→ 3. bab696a71d6c6a39... (current)", color: COLORS.info, delay: 39 },
    { text: "", delay: 42 },
    { text: "=== Global Settings ===", color: COLORS.accent, delay: 45 },
    { text: "Skip Hash Check: false", color: COLORS.textMuted, delay: 48 },
  ];

  return (
    <Terminal title="vibe verify — Terminal">
      {/* Title */}
      <div
        style={{
          color: COLORS.accent,
          fontSize: 24,
          marginBottom: 16,
          fontWeight: 600,
        }}
      >
        vibe verify
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          marginBottom: 24,
          fontSize: 16,
        }}
      >
        Verify config trust status and hash history
      </div>

      {/* Command */}
      <CommandPrompt
        command="vibe verify"
        startFrame={15}
        typeSpeed={2}
        showCursor={!commandTypingComplete}
      />

      {/* Output */}
      {commandTypingComplete && (
        <CommandOutput lines={outputLines} startFrame={outputStartFrame} lineDelay={3} />
      )}
    </Terminal>
  );
};
