import React, { useEffect, useRef } from "react";

type Props = {
  rpm?: number;
  clockwise?: boolean;
};

// control-demo: the upstream component advanced the angle only when a new rpm
// value arrived, so the spool jumped in steps (and stopped when the rounded rpm
// did not change). Here the latest rpm is kept in a ref and the angle advances
// on every animation frame, written straight to the element's transform:
// smooth rotation at display rate without re-rendering React.
export function Spool({ rpm, clockwise }: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const rpmRef = useRef(rpm ?? 0);
  const directionRef = useRef(clockwise ? 1 : -1);

  useEffect(() => {
    rpmRef.current = rpm ?? 0;
    directionRef.current = clockwise ? 1 : -1;
  }, [rpm, clockwise]);

  useEffect(() => {
    let rotations = 0;
    let last: number | undefined;
    let frame = requestAnimationFrame(function tick(now) {
      // cap the step so a background tab does not jump on return
      const dt = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      rotations = (rotations + (rpmRef.current / 60) * dt) % 1;
      if (elementRef.current) {
        elementRef.current.style.transform = `rotate(${directionRef.current * rotations * 360}deg)`;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex w-full justify-center">
      <div
        ref={elementRef}
        className="aspect-square h-32"
        style={{ willChange: "transform" }}
      >
        <svg
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="221" y="8" width="70" height="182" fill="black" />
          <rect
            x="490.617"
            y="351"
            width="70"
            height="182"
            transform="rotate(120 490.617 351)"
            fill="black"
          />
          <rect
            x="51"
            y="403.033"
            width="70"
            height="182"
            transform="rotate(-120 51 403.033)"
            fill="black"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M256.498 511.998C398.159 511.998 512.998 397.159 512.998 255.498C512.998 113.837 398.159 -1.00195 256.498 -1.00195C114.837 -1.00195 -0.00195312 113.837 -0.00195312 255.498C-0.00195312 397.159 114.837 511.998 256.498 511.998ZM255.5 447C361.815 447 448 360.815 448 254.5C448 148.185 361.815 62 255.5 62C149.185 62 63 148.185 63 254.5C63 360.815 149.185 447 255.5 447Z"
            fill="black"
          />

          <path
            d="M255.5 381C324.812 381 381 324.812 381 255.5C381 186.188 324.812 130 255.5 130C186.188 130 130 186.188 130 255.5C130 324.812 186.188 381 255.5 381ZM256 319C290.794 319 319 290.794 319 256C319 221.206 290.794 193 256 193C221.206 193 193 221.206 193 256C193 290.794 221.206 319 256 319Z"
            fill="black"
          />
          <circle
            cx="256"
            cy="255"
            r="50"
            fill="black"
            className="fill-gray-300"
          />
        </svg>
      </div>
    </div>
  );
}
