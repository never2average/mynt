"use client"

// shadcn/ui's Calendar (MIT), on react-day-picker 9: a month grid in the studio's tokens, for picking a day
// or a range. Used by the date filters (components/filter-controls.tsx).
import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-2 [--cell-size:2rem]", className)}
      classNames={{
        root: "w-fit",
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex w-full flex-col gap-3",
        nav: "absolute inset-x-0 top-0 flex w-full items-center justify-between",
        button_previous: "inline-flex size-(--cell-size) items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40",
        button_next: "inline-flex size-(--cell-size) items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40",
        month_caption: "flex h-(--cell-size) items-center justify-center px-(--cell-size)",
        caption_label: "text-sm font-medium",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "flex-1 text-[0.75rem] font-normal text-muted-foreground select-none",
        week: "mt-1 flex w-full",
        day: "relative aspect-square size-(--cell-size) p-0 text-center text-sm select-none",
        day_button:
          "inline-flex size-full items-center justify-center rounded-md tabular-nums hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        range_start: "rounded-l-md bg-accent [&>button]:bg-primary [&>button]:text-primary-foreground",
        range_middle: "bg-accent [&>button]:rounded-none",
        range_end: "rounded-r-md bg-accent [&>button]:bg-primary [&>button]:text-primary-foreground",
        selected: "[&>button]:bg-primary [&>button]:text-primary-foreground",
        today: "[&>button]:font-semibold [&>button]:underline [&>button]:underline-offset-4",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-40",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: c, ...rest }) => (orientation === "left" ? <ChevronLeft className={cn("size-4", c)} {...rest} /> : <ChevronRight className={cn("size-4", c)} {...rest} />),
      }}
      {...props}
    />
  )
}
