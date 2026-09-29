import { revalidateAction } from "./actions.js";

export const dynamic = "force-dynamic";

// Server-action forms used by the e2e tests (revalidateTag with/without a profile, revalidatePath).
export default function ActionsPage() {
  const forms = [
    { id: "tag-none", tag: "pinned", profile: "none" },
    { id: "tag-max", tag: "pinned", profile: "max" },
    { id: "tag-expire", tag: "pinned", profile: "expire:60" },
    { id: "path", path: "/pinned/1" },
  ];
  return (
    <main>
      <p id="page">actions</p>
      {forms.map((f) => (
        <form key={f.id} id={f.id} action={revalidateAction}>
          {f.tag && <input type="hidden" name="tag" value={f.tag} />}
          {f.path && <input type="hidden" name="path" value={f.path} />}
          {f.profile && <input type="hidden" name="profile" value={f.profile} />}
          <button type="submit">{f.id}</button>
        </form>
      ))}
    </main>
  );
}
