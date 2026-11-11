export function dictationDiff(reference: string, text: string): { type: "equal" | "extra" | "missing"; text: string }[];
