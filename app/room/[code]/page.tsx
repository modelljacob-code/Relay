import { RoomView } from "./RoomView";

export default function RoomPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return <RoomView code={code} />;
}
