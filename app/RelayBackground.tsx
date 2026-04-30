/**
 * App-wide backdrop: lighter steel-blue with a readable, obvious gradient.
 * Stops chosen so headings/taglines stay high-contrast over the upper area.
 */
export function RelayBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden>
      {/* Primary vertical gradient — clearly lighter at top, deeper at bottom */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#6f93c9] via-[#4f719f] to-[#2d4664]" />
      {/* Diagonal wash — extra depth and visible color movement */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#9dbef0]/35 via-transparent to-[#1e3348]/55" />
      {/* Soft upper glow — keeps hero zone airy without a harsh spotlight */}
      <div className="absolute left-1/2 top-[22%] h-56 w-[min(90vw,22rem)] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-[#8eb4e8]/35 blur-[100px]" />
    </div>
  );
}
