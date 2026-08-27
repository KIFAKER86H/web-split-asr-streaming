"use client";

import { useEffect, useId, useRef, useState } from "react";

import { CheckIcon, ChevronDownIcon } from "@/components/icons";

export interface ListboxOption {
  value: string;
  label: string;
  /**
   * Draws the row in this family. A font picker that lists every name in the
   * same face tells you nothing about what you are choosing.
   */
  fontFamily?: string;
}

interface DeviceListboxProps {
  options: ListboxOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Accessible name for the control. */
  label: string;
  /** Shown on the trigger when there is nothing to choose from. */
  emptyLabel: string;
}

/**
 * A listbox built from scratch rather than a native `<select>`: the option list
 * of a native select is drawn by the OS and ignores the page's dark styling.
 *
 * Follows the ARIA listbox pattern — the trigger owns the popup, and while open
 * the list itself holds focus and tracks the highlighted row through
 * `aria-activedescendant`.
 */
export function DeviceListbox({
  options,
  value,
  onChange,
  disabled = false,
  label,
  emptyLabel,
}: DeviceListboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const baseId = useId();

  const isEmpty = options.length === 0;
  const expanded = open && !disabled && !isEmpty;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expanded]);

  useEffect(() => {
    if (expanded) {
      listRef.current?.focus();
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    document
      .getElementById(`${baseId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, baseId]);

  const openList = () => {
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) {
      onChange(option.value);
    }
    close();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openList();
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        // The settings panel closes on Escape too; while this list is open it
        // is the innermost thing the key applies to, so it consumes the event.
        event.stopPropagation();
        close();
        break;
      case "Tab":
        close();
        break;
      default:
        break;
    }
  };

  return (
    // `w-fit` so the popup's right edge lines up with the trigger's rather than
    // with whatever width the surrounding row happens to have.
    <div ref={containerRef} className="relative w-fit">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || isEmpty}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-label={label}
        onClick={() => (expanded ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
        className="flex max-w-[min(18rem,60vw)] items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-white/70"
      >
        <span className="truncate" style={{ fontFamily: selected?.fontFamily }}>
          {selected?.label ?? emptyLabel}
        </span>
        <ChevronDownIcon
          className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={handleListKeyDown}
          className="absolute right-0 top-full z-20 mt-2 max-h-80 w-max min-w-56 max-w-[min(22rem,80vw)] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/95 p-1 shadow-2xl shadow-black/60 outline-none backdrop-blur"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;

            return (
              <li
                key={option.value || `index-${index}`}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                onClick={() => commit(index)}
                onPointerEnter={() => setActiveIndex(index)}
                className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                  index === activeIndex ? "bg-white/10 text-white" : "text-white/70"
                }`}
              >
                <CheckIcon
                  className={`size-3.5 shrink-0 ${isSelected ? "text-accent" : "invisible"}`}
                />
                <span className="truncate" style={{ fontFamily: option.fontFamily }}>
                  {option.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
