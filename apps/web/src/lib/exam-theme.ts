import {
  voyageExamAttrs,
  type VoyageExamContrast,
  type VoyageExamTextSize,
} from "@yiminlab/voyage";

/** Adapt historical draft values without changing stored exam contracts. */
export function ieltsExamAttrs(contrast: string, text: string) {
  const contrasts: Record<string, VoyageExamContrast> = {
    "black-white": "black-on-white",
    "white-black": "white-on-black",
    "yellow-black": "yellow-on-black",
  };
  const sizes: Record<string, VoyageExamTextSize> = {
    regular: "regular",
    large: "large",
    extra: "x-large",
    "extra-large": "x-large",
  };
  return voyageExamAttrs({
    theme: "ielts",
    contrast: contrasts[contrast],
    text: sizes[text],
  });
}
