import { revalidateAction, updateTagAction } from "./actions.js";

// Server-action forms used by the e2e tests: updateTag (read-your-writes) and revalidateTag profiles.
export default function ActionsPage() {
  return (
    <main>
      <p id="page">actions</p>
      <form id="update-uc" action={updateTagAction}>
        <input type="hidden" name="tag" value="uc" />
        <button type="submit">updateTag uc</button>
      </form>
      <form id="revalidate-uc-max" action={revalidateAction}>
        <input type="hidden" name="tag" value="uc" />
        <input type="hidden" name="profile" value="max" />
        <button type="submit">revalidateTag uc max</button>
      </form>
      <form id="revalidate-uc-expire" action={revalidateAction}>
        <input type="hidden" name="tag" value="uc" />
        <input type="hidden" name="profile" value="expire:60" />
        <button type="submit">revalidateTag uc expire 60</button>
      </form>
    </main>
  );
}
