import * as React from "react"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  controlSize = "default",
  ...props
}: React.ComponentProps<"input"> & {
  controlSize?: "default" | "sm"
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={controlSize}
      className={cn(
        "h-10 w-full min-w-0 rounded-lg border border-input bg-[var(--control-bg)] px-3 py-1 text-sm text-foreground transition-[color,background-color,border-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted/45 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-[var(--disabled-opacity)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=sm]:h-8 data-[size=sm]:px-2.5",
        className
      )}
      {...props}
    />
  )
}

export { Input }
