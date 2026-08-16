import { useQuery } from "@tanstack/react-query";
import { type Meta, api } from "./lib/api";
import { AppShell } from "./lib/app-shell";
import { useSession } from "./lib/auth";
import { setModuleRelease } from "./lib/module-ui";
import {
  Breadcrumb,
  NavigationProvider,
  useNavigation,
} from "./lib/navigation";
import { Bookkeeping } from "./routes/bookkeeping";
import { ContactDetail } from "./routes/contact-detail";
import { Contacts } from "./routes/contacts";
import { ResetPassword } from "./routes/forgot-password";
import { Forms } from "./routes/forms";
import { Invoices } from "./routes/invoices";
import { ModuleScreen } from "./routes/module-screen";
import { Quotes } from "./routes/quotes";
import { Settings } from "./routes/settings";
import { Setup } from "./routes/setup";
import { SignIn } from "./routes/sign-in";

/**
 * Which screen a nav entry opens.
 *
 * Keyed by the module id the server registered, so a module the licence does
 * not load has no nav entry and no way in. A module whose screens ship
 * elsewhere simply has no entry here yet.
 */
const SCREENS: Record<string, () => React.ReactElement | null> = {
  crm: Contacts,
  invoicing: Invoices,
  quotes: Quotes,
  bookkeeping: Bookkeeping,
  forms: Forms,
  settings: Settings,
};

/** Screens that show a single record, chosen when navigation names one. */
const RECORD_SCREENS: Record<string, () => React.ReactElement | null> = {
  crm: ContactDetail,
};

function useMeta() {
  return useQuery({
    queryKey: ["meta"],
    queryFn: async () => {
      const meta = await api<Meta>("/api/_meta");
      // Before any module script is requested, so an upgraded instance never
      // serves the previous release's screen from cache.
      setModuleRelease(meta.version ?? "");
      return meta;
    },
  });
}

/**
 * The nav renders only what the server loaded, which is only what the license
 * entitles — the UI can never show a feature the instance isn't licensed for.
 */
function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: () =>
      api<{
        needed: boolean;
        signUpOpen: boolean;
        setupTokenRequired: boolean;
      }>("/api/bootstrap"),
    staleTime: 0,
  });
}

/** The screen for wherever navigation currently points. */
function CurrentScreen({ nav }: { nav: Meta["nav"] }) {
  const { current } = useNavigation();

  // A module can have a screen for one record as well as a list. Without this
  // the record id is carried around and never used, which is how the previous
  // navigation model quietly prevented anything linking to anything.
  const Screen = current.recordId
    ? (RECORD_SCREENS[current.moduleId] ?? SCREENS[current.moduleId])
    : SCREENS[current.moduleId];
  const entry = nav.find((n) => n.id === current.moduleId);

  return (
    <>
      <Breadcrumb />
      <h1 className="mb-4 text-lg font-semibold">
        {entry?.label ?? current.title}
      </h1>
      {Screen ? (
        <Screen />
      ) : (
        // Not a Core screen: the module may have shipped its own. The script is
        // fetched by module id, which is not always the nav id.
        <ModuleScreen
          moduleId={entry?.moduleId ?? current.moduleId}
          screenId={current.moduleId}
          label={entry?.label ?? current.moduleId}
        />
      )}
    </>
  );
}

export default function App() {
  const { data } = useMeta();
  const session = useSession();
  const bootstrap = useBootstrap();
  const nav = data?.nav ?? [];

  // The emailed reset link lands here with no session, and must be reachable
  // before the sign-in form or the bootstrap screen takes the page.
  if (window.location.pathname === "/reset-password") return <ResetPassword />;

  if (session.isPending || bootstrap.isLoading) return null;
  // A fresh instance has no owner yet: claim it before anything else.
  if (bootstrap.data?.needed) {
    return (
      <Setup
        tokenRequired={bootstrap.data.setupTokenRequired}
        onDone={() => window.location.reload()}
      />
    );
  }
  if (!session.data) return <SignIn />;

  // Whatever the server put first, rather than a hard-coded module: a Core
  // instance and a Pro one with a dashboard should each land somewhere that
  // exists, and neither should land on a module the licence did not load.
  const landing = nav.find((n) => n.id !== "settings") ?? nav[0];
  if (!landing) return null;

  return (
    <NavigationProvider
      initial={{ moduleId: landing.id, title: landing.label }}
    >
      <AppShell nav={nav} user={session.data.user}>
        <CurrentScreen nav={nav} />
      </AppShell>
    </NavigationProvider>
  );
}
