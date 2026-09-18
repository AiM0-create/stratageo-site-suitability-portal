import { useEffect, useState } from 'react';

/**
 * v2.3.0 — one breakpoint decides the phone layout (bottom-sheet results,
 * collapsed top bar). It matches the `@media (max-width: 640px)` block in
 * main.css exactly; the two must move together.
 */
export const PHONE_MAX_WIDTH_PX = 640;
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState<boolean>(() => {
    try { return window.matchMedia(PHONE_MEDIA_QUERY).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(PHONE_MEDIA_QUERY); } catch { return; }
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}
