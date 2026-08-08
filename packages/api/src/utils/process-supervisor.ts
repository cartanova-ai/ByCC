/**
 * 프로세스 모니터링 도구 감지.
 *
 * 화면의 "재시작"은 스스로를 종료하는 것이다 — pm2 같은 도구가 죽은 프로세스를 다시
 * 띄워주는 것이 곧 재시작이다. 그래서 그런 도구 없이 종료하면 그냥 서버가 내려간다.
 * 로컬 개발에서 버튼을 누르면 아무도 살려주지 않으므로, 종료 전에 반드시 확인한다.
 *
 * 현재 배포 계약은 pm2 만 재시작을 보장한다. systemd 의 `INVOCATION_ID` 는 해당
 * unit 이 `Restart=` 를 쓴다는 뜻이 아니므로 안전한 감독자 신호로 사용할 수 없다.
 *
 * 값이 아니라 존재 여부가 신호다. pm2 는 첫 프로세스에 `pm_id=0` 을 주므로 truthy 검사로
 * 판별하면 놓친다.
 */
export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): "pm2" | null {
  if (env.pm_id !== undefined) return "pm2";
  return null;
}
