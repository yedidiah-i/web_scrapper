import Image from "next/image";

export default function ScrappyBrand({
  subtitle,
  size = 38,
  className = "",
}: {
  subtitle?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-3 ${className}`}>
      <Image
        src="/scrappy-mark.svg"
        alt=""
        width={size}
        height={size}
        priority
        className="shrink-0 object-contain"
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight text-zinc-100">Scrappy</span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-zinc-500">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
