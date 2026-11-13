import type { LibraryItem } from "../types";

export default function MaterialDifficulty({ item }: { item: LibraryItem }) {
  return (
    <span
      className="material-difficulty"
      title="沿用归档的原始难度值，0–3 的中文等级含义尚待核实。"
    >
      {item.difficulty === undefined
        ? "难度未提供"
        : `雅思哥难度 ${item.difficulty}`}
    </span>
  );
}
