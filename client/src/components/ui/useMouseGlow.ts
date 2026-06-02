'use client';

import { MouseEvent, RefObject, useRef, useState } from 'react';

interface MouseGlowState {
  ref: RefObject<HTMLDivElement | null>;
  pos: { x: number; y: number };
  active: boolean;
  bind: {
    onMouseMove: (e: MouseEvent<HTMLDivElement>) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
}

/**
 * 滑鼠跟隨光斒 hook。把 ref + bind 套到一個容器元素,
 * 然後用 pos / active 在裡面畫 radial-gradient blob。
 */
export function useMouseGlow(): MouseGlowState {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  return {
    ref,
    pos,
    active,
    bind: {
      onMouseMove: (e: MouseEvent<HTMLDivElement>) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      },
      onMouseEnter: () => setActive(true),
      onMouseLeave: () => setActive(false),
    },
  };
}
