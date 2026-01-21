import React from "react";
import { useCurrentFrame } from "remotion";
import { COLORS } from "../styles/colors";

interface CursorProps {
  visible?: boolean;
  blinkInterval?: number;
}

export const Cursor: React.FC<CursorProps> = ({
  visible = true,
  blinkInterval = 15,
}) => {
  const frame = useCurrentFrame();
  const isVisible = visible && Math.floor(frame / blinkInterval) % 2 === 0;

  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 22,
        backgroundColor: isVisible ? COLORS.cursor : "transparent",
        marginLeft: 2,
        verticalAlign: "middle",
      }}
    />
  );
};
