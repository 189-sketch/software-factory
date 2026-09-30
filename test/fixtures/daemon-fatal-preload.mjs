setTimeout(() => {
  if (process.env.FACTORY_FATAL_PROBE_KIND === "unhandledRejection") {
    Promise.reject(new Error("fatal-probe"));
    return;
  }
  throw new Error("fatal-probe");
}, 750);
