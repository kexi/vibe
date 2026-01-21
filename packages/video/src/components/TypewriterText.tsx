import React from "react";
import { useCurrentFrame } from "remotion";
import { Cursor } from "./Cursor";

interface TypewriterTextProps {
  text: string;
  startFrame?: number;
  speed?: number;
  showCursor?: boolean;
  cursorAfterComplete?: boolean;
  style?: React.CSSProperties;
}

export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame = 0,
  speed = 2,
  showCursor = true,
  cursorAfterComplete = false,
  style,
}) => {
  const frame = useCurrentFrame();
  const relativeFrame = Math.max(0, frame - startFrame);

  const charsToShow = Math.floor(relativeFrame / speed);
  const displayedText = text.slice(0, charsToShow);
  const isComplete = charsToShow >= text.length;

  const shouldShowCursor = showCursor && (!isComplete || cursorAfterComplete);

  return (
    <span style={style}>
      {displayedText}
      {shouldShowCursor && <Cursor />}
    </span>
  );
};
