import { ChevronDown } from "lucide-react";
import type { QuestionRow } from "../lib/questions.mjs";
import { textOf } from "../lib/content";
import "./matching-select.css";

// Keep the native keyboard/touch picker, with full descriptions in its menu.
export default function MatchingSelect({
  row,
  value,
  disabled,
  onChange,
  onFocus,
  label,
  placeholder = "选择",
}: {
  row: QuestionRow;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  label: string;
  placeholder?: string;
}) {
  const selected = row.options.find((option) => option.value === value);
  const description = (option: QuestionRow["options"][number]) => {
    const content = textOf(option.content).replace(/\s+/g, " ").trim();
    return content ? `${option.label} — ${content}` : option.label;
  };
  return (
    <span className="matching-select">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        title={selected ? description(selected) : placeholder}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {row.options.map((option) => (
          <option key={option.value} value={option.value}>
            {description(option)}
          </option>
        ))}
      </select>
      <span className="matching-select-value" aria-hidden="true">
        {selected?.label || placeholder}
        <ChevronDown size={14} />
      </span>
    </span>
  );
}
