export const projectName = "ReproGuard + ItWorksHere";

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`${projectName} baseline is ready.`);
}
