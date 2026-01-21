import React from "react";
import { useCurrentFrame } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const TrustCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 40;
  const outputStartFrame = 55;

  // 実際のvibe trustの出力形式に合わせる
  const outputLines = [
    { text: "", delay: 0 },
    { text: "Trusted files:", color: COLORS.text },
    { text: "  /Users/kei/ghq/github.com/kexi/vibe/.vibe.toml", color: COLORS.text, delay: 6 },
    { text: "    Repository: github.com/kexi/vibe", color: COLORS.textMuted, delay: 9 },
    { text: "    Relative Path: .vibe.toml", color: COLORS.textMuted, delay: 12 },
    { text: "", delay: 15 },
    { text: "Settings: /Users/kei/.config/vibe/settings.json", color: COLORS.textMuted, delay: 18 },
  ];

  return (
    <Terminal title="vibe trust — Terminal">
      {/* Title */}
      <div
        style={{
          color: COLORS.accent,
          fontSize: 24,
          marginBottom: 16,
          fontWeight: 600,
        }}
      >
        vibe trust
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          marginBottom: 24,
          fontSize: 16,
        }}
      >
        Trust .vibe.toml config (SHA-256 hash verification)
      </div>

      {/* Command */}
      <CommandPrompt
        command="vibe trust"
        startFrame={15}
        typeSpeed={2}
        showCursor={!commandTypingComplete}
      />

      {/* Output */}
      {commandTypingComplete && (
        <CommandOutput
          lines={outputLines}
          startFrame={outputStartFrame}
          lineDelay={3}
        />
      )}
    </Terminal>
  );
};
