"use client";

import { useEffect, useState } from "react";

export function CurrentTime() {
  const [time, setTime] = useState("");

  useEffect(() => {
    setTime(new Date().toISOString());
  }, []);

  return <span style={{ fontFamily: "monospace" }}>{time || "..."}</span>;
}
