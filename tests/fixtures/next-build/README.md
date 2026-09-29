# next-build 픽스처

`test-apps/static-site`를 Next 16.3.6으로 빌드한 산출물 일부(`/`, `/about`, `/_not-found`, `/icon`).
`registerInitialCache`(프리워밍) 재현 테스트(7-4)가 `process.cwd()`를 이 디렉토리로 바꿔 읽는다.
`prerender-manifest.json`은 위 4개 라우트만 남기고 preview 키는 더미로 바꿨다.

갱신: `node scripts/prepare-app.mjs static-site --build A` 후 `.work/static-site@next-16.3/builds/A/.next`에서 같은 파일을 복사한다.
