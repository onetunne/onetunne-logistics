import { cx } from "./cx";
import { ImageIcon } from "./internal";

export type ThumbnailSize = "sm" | "md" | "lg";

export interface ThumbnailProps {
  src?: string | null;
  alt: string;
  size?: ThumbnailSize;
  className?: string;
}

const PX: Record<ThumbnailSize, number> = { sm: 32, md: 48, lg: 80 };

/** Мініатюра товару. Без src — нейтральний плейсхолдер. Зображення завантажуються ліниво. */
export function Thumbnail({ src, alt, size = "md", className }: ThumbnailProps) {
  const classes = cx("ot-thumb", `ot-thumb--${size}`, !src && "ot-thumb--placeholder", className);
  if (src) {
    return (
      <span className={classes}>
        <img src={src} alt={alt} width={PX[size]} height={PX[size]} loading="lazy" decoding="async" />
      </span>
    );
  }
  return (
    <span className={classes} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>
      <ImageIcon />
    </span>
  );
}
