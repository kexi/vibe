import React from "react";
import { COLORS } from "../styles/colors";
import { TypewriterText } from "./TypewriterText";
import { Cursor } from "./Cursor";

interface CommandPromptProps {
  command: string;
  startFrame?: number;
  typeSpeed?: number;
  showCursor?: boolean;
  promptPath?: string;
}

export const CommandPrompt: React.FC<CommandPromptProps> = ({
  command,
  startFrame = 0,
  typeSpeed = 2,
  showCursor = true,
  promptPath = "~/project",
}) => {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
      {/* Prompt */}
      <span style={{ color: COLORS.promptPath }}>{promptPath}</span>
      <span style={{ color: COLORS.textMuted }}> on </span>
      <span style={{ color: COLORS.accent }}>feature/demo</span>
      <span style={{ color: COLORS.promptSymbol }}> ❯ </span>
      {/* Command with typewriter effect */}
      <TypewriterText
        text={command}
        startFrame={startFrame}
        speed={typeSpeed}
        showCursor={showCursor}
        style={{ color: COLORS.textBright }}
      />
    </div>
  );
};
