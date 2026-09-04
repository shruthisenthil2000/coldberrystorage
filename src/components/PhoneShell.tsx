import { useEffect, useState, type ReactNode } from "react";
import { BatteryMedium, Signal, Wifi, WifiOff } from "lucide-react";

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function useBattery(): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ level: number; addEventListener: (e: string, h: () => void) => void }>;
    };
    if (!nav.getBattery) return;
    let battery: { level: number; addEventListener: (e: string, h: () => void) => void } | null = null;
    const onChange = () => battery && setLevel(Math.round(battery.level * 100));
    nav
      .getBattery()
      .then((b) => {
        battery = b;
        onChange();
        b.addEventListener("levelchange", onChange);
      })
      .catch(() => setLevel(null));
    return () => setLevel(null);
  }, []);
  return level;
}

/** Simulated device status bar: live clock, signal, network, battery. */
function StatusBar({ online }: { online: boolean }) {
  const time = useClock();
  const battery = useBattery();

  return (
    <div
      className="flex shrink-0 items-center justify-between px-5 pt-2 pb-1 text-[13px] font-semibold text-foreground"
      aria-hidden="true"
    >
      <span className="tabular-nums">{time}</span>
      <span className="flex items-center gap-1.5">
        <Signal className="size-3.5" />
        {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
        <span className="flex items-center gap-0.5">
          {battery !== null && <span className="text-[11px] tabular-nums">{battery}%</span>}
          <BatteryMedium className="size-4.5" />
        </span>
      </span>
    </div>
  );
}

export function PhoneShell({ children, online }: { children: ReactNode; online: boolean }) {
  return (
    <div className="phone-stage">
      <div className="phone-frame">
        <StatusBar online={online} />
        {children}
      </div>
    </div>
  );
}
