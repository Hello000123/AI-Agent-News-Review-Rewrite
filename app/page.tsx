import { ReviewWorkspacePage } from "@/components/review-workspace-page";
import { requirePageSession } from "@/lib/server/auth/guards";
import { getReviewPassScore, getWebsiteDefaultModel } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await requirePageSession("/");
  return (
    <ReviewWorkspacePage
      user={session.user}
      passScore={getReviewPassScore()}
      initialModel={getWebsiteDefaultModel()}
    />
  );
}
