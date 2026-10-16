import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

interface SelectOption { value: string; label: string; disabled?: boolean }
interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
  "aria-label": string;
}
interface Placement { left: number; top: number; width: number; maxHeight: number }

/** A select-only combobox; focus stays on the trigger while the list is open. */
export function Select({ value, options, onChange, disabled = false, "aria-label": label }: SelectProps) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const search = useRef({ text: "", time: 0 });
  const selected = options.findIndex(option => option.value === value);
  const locked = disabled || !options.some(option => !option.disabled);
  const activeOption = options[active];

  function show(index = selected) {
    if (locked || trigger.current?.matches(":disabled")) return;
    trigger.current?.focus({ preventScroll: true });
    setActive(index >= 0 && !options[index]?.disabled ? index : options.findIndex(option => !option.disabled));
    search.current = { text: "", time: 0 };
    setOpen(true);
  }
  function commit(index: number) {
    const option = options[index];
    if (locked || trigger.current?.matches(":disabled") || !option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }
  function step(direction: number) {
    for (let count = 1; count <= options.length; count++) {
      const index = (active + direction * count + options.length) % options.length;
      if (!options[index]?.disabled) { setActive(index); return; }
    }
  }
  function edge(last: boolean) {
    const index = last ? options.reduce((found, option, index) => option.disabled ? found : index, -1) : options.findIndex(option => !option.disabled);
    if (open) setActive(index); else show(index);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (locked) return;
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home" || event.key === "End") edge(event.key === "End");
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (open) step(event.key === "ArrowDown" ? 1 : -1); else show();
      } else if (open) commit(active); else show();
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const now = Date.now(), character = event.key.toLocaleLowerCase();
    const text = now - search.current.time < 700 ? search.current.text + character : character;
    search.current = { text, time: now };
    const prefix = [...text].every(letter => letter === character) ? character : text;
    const start = open ? active : selected;
    for (let count = 1; count <= options.length; count++) {
      const index = (start + count + options.length) % options.length, option = options[index];
      if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) {
        if (!open) setOpen(true);
        setActive(index);
        break;
      }
    }
  }

  useLayoutEffect(() => { setOpen(false); }, [value, locked]);
  // This also handles parents that remain mounted under a hidden page/fieldset.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    if (!anchor || !anchor.getClientRects().length || anchor.matches(":disabled")) { setOpen(false); return; }
    function position() {
      if (!anchor || !anchor.getClientRects().length || anchor.matches(":disabled")) { setOpen(false); return; }
      const rect = anchor.getBoundingClientRect(), margin = 10, gap = 6;
      const viewportWidth = document.documentElement.clientWidth, viewportHeight = window.innerHeight;
      if (rect.bottom < 0 || rect.top > viewportHeight) { setOpen(false); return; }
      const below = viewportHeight - rect.bottom - margin - gap, above = rect.top - margin - gap;
      const upward = below < Math.min(280, menu.current?.scrollHeight ?? 280) && above > below;
      const maxHeight = Math.max(0, Math.min(280, upward ? above : below));
      const height = Math.min(menu.current?.scrollHeight ?? maxHeight, maxHeight);
      const width = Math.min(Math.max(rect.width, 160), viewportWidth - margin * 2);
      const next = { left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
        top: upward ? rect.top - gap - height : rect.bottom + gap, width, maxHeight };
      setPlacement(previous => previous && Object.entries(next).every(([key, value]) => previous[key as keyof Placement] === value) ? previous : next);
    }
    position();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !anchor?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      position();
    }
    const dialog = anchor.closest("dialog");
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", position);
    dialog?.addEventListener("close", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", position);
      dialog?.removeEventListener("close", close);
    };
  });
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const option = document.getElementById(`${id}-option-${active}`), list = menu.current;
    if (!option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [open, active, placement, id]);

  // A modal dialog makes body portals inert; keep its list in the same top layer.
  const portalHost = trigger.current?.closest("dialog[open]") ?? document.body;
  return <>
    <button ref={trigger} type="button" className="select-trigger" role="combobox" aria-label={label}
      disabled={locked} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open && activeOption ? `${id}-option-${active}` : undefined}
      title={options[selected]?.label} onKeyDown={keyDown} onBlur={() => setOpen(false)}
      onClick={() => open ? setOpen(false) : show()}>
      <span className="select-value">{options[selected]?.label ?? "\u00a0"}</span>
      <svg className="select-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && !locked && createPortal(<div ref={menu} id={`${id}-list`} role="listbox" aria-label={label}
      className="select-menu" style={placement ? placement as CSSProperties : { visibility: "hidden" }}
      onPointerDown={event => event.preventDefault()} onClick={event => event.stopPropagation()}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        className={`select-option${active === index ? " is-active" : ""}`}
        onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => commit(index)}>
        <span>{option.label}</span><svg className="select-check" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>)}
    </div>, portalHost)}
  </>;
}
