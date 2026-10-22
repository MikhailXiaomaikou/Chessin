import { Select } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { annotationPaletteAtom } from "@/state/atoms";

/** Settings row "注释配色 / Annotation colours": default vs. the Okabe–Ito colour-blind-safe palette. */
export default function AnnotationPaletteSelect() {
  const { t } = useTranslation();
  const [palette, setPalette] = useAtom(annotationPaletteAtom);
  return (
    <Select
      aria-label={t("A11y.Settings.Palette")}
      allowDeselect={false}
      data={[
        { value: "default", label: t("A11y.Settings.Palette.Default") },
        { value: "okabe-ito", label: t("A11y.Settings.Palette.OkabeIto") },
      ]}
      value={palette}
      onChange={(value) => {
        if (value === "default" || value === "okabe-ito") setPalette(value);
      }}
    />
  );
}
