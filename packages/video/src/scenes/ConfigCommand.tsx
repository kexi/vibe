import React from "react";
import { useCurrentFrame } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const ConfigCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 45;
  const outputStartFrame = 60;

  // 実際のvibe configの出力形式に合わせる（JSON形式）
  const outputLines = [
    { text: "", delay: 0 },
    { text: "Settings file: /Users/kei/.config/vibe/settings.json", color: COLORS.textMuted },
    { text: "", delay: 6 },
    { text: "{", color: COLORS.text, delay: 9 },
    {
      text: '  "$schema": "https://...vibe/main/schemas/settings.schema.json",',
      color: COLORS.textMuted,
      delay: 12,
    },
    { text: '  "version": 3,', color: COLORS.text, delay: 15 },
    { text: '  "skipHashCheck": false,', color: COLORS.text, delay: 18 },
    { text: '  "permissions": {', color: COLORS.text, delay: 21 },
    { text: '    "allow": [', color: COLORS.text, delay: 24 },
    { text: "      { ... }", color: COLORS.textMuted, delay: 27 },
    { text: "    ],", color: COLORS.text, delay: 30 },
    { text: '    "deny": []', color: COLORS.text, delay: 33 },
    { text: "  }", color: COLORS.text, delay: 36 },
    { text: "}", color: COLORS.text, delay: 39 },
  ];

  return (
    <Terminal title="vibe config — Terminal">
      {/* Title */}
      <div
        style={{
          color: COLORS.accent,
          fontSize: 24,
          marginBottom: 16,
          fontWeight: 600,
        }}
      >
        vibe config
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          marginBottom: 24,
          fontSize: 16,
        }}
      >
        Show current settings (JSON format)
      </div>

      {/* Command */}
      <CommandPrompt
        command="vibe config"
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
