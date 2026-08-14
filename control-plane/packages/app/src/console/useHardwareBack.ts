/**
 * Android hardware back, as a hook the console can own.
 *
 * When a session is open the system back button must return to the sessions
 * list and claim the event so the OS does not finish the activity. When the
 * bay is already showing, the subscription is gone and the OS keeps its
 * default (leave the app). Extracted so the contract can be tested without
 * mounting the whole socket-backed console.
 */

import { useEffect } from "react";
import { BackHandler } from "react-native";

export function useHardwareBack(armed: boolean, onBack: () => void): void {
  useEffect(() => {
    if (!armed) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, [armed, onBack]);
}
