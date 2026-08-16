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
import { Loading, setFormats } from "./lib/ui";
import { Bookkeeping } from "./routes/bookkeeping";
import { Companies, CompanyDetail } from "./routes/companies";
import { ContactDetail } from "./routes/contact-detail";
import { Contacts } from "./routes/contacts";
import { Dashboard } from "./routes/dashboard";
import { DealDetail } from "./routes/deal-detail";
import { Deals } from "./routes/deals";
import { ResetPassword } from "./routes/forgot-password";
import { Forms } from "./routes/forms";
import { Invoices } from "./routes/invoices";
import { ModuleScreen } from "./routes/module-screen";
import { type Profile, ProfileScreen } from "./routes/profile";
import { Quotes } from "./routes/quotes";
import { Settings } from "./routes/settings";
import { Setup } from "./routes/setup";
import { SignIn } from "./routes/sign-in";
import { Users } from "./routes/users";

/**
 * Which screen a nav entry opens.
 *
 * Keyed by the module id the server registered, so a module the licence does
 * not load has no nav entry and no way in. A module whose screens ship
 * elsewhere simply has no entry here yet.
 */
const SCREENS: Record<string, () => React.ReactElement | null> = {
  dashboard: Dashboard,
  crm: Contacts,
  companies: Companies,
  deals: Deals,
  invoicing: Invoices,
  quotes: Quotes,
  bookkeeping: Bookkeeping,
  forms: Forms,
  settings: Settings,
  users: Users,
  profile: ProfileScreen,
};

/** Screens that show a single record, chosen when navigation names one. */
const RECORD_SCREENS: Record<string, () => React.ReactElement | null> = {
  crm: ContactDetail,
  companies: CompanyDetail,
  deals: DealDetail,
};

/**
 * The reader's own preferences, fetched once and handed to the formatters.
 *
 * Before the first screen renders rather than inside one: dates and money are
 * formatted from module-level state, so a screen that paints first would show
 * the wrong currency until something happened to re-render it.
 */
function useProfile(signedIn: boolean) {
  return useQuery({
    queryKey: ["profile"],
    enabled: signedIn,
    queryFn: async () => {
      const profile = await api<Profile>("/api/profile");
      setFormats(profile.preferences);
      return profile;
    },
  });
}

function useMeta(signedIn: boolean) {
  return useQuery({
    queryKey: ["meta"],
    // Both of these need a session, and asking without one is three failed
    // requests behind the sign-in form on every load — noise in the log of
    // whoever is trying to work out why something is wrong.
    enabled: signedIn,
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
  const session = useSession();
  const signedIn = Boolean(session.data);
  const meta = useMeta(signedIn);
  const data = meta.data;
  const bootstrap = useBootstrap();
  const profile = useProfile(signedIn);
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
  // Signed in, and the shell does not know what to draw yet. Both of these
  // wait on the session, so they cannot be fetched alongside it.
  if (meta.isLoading || profile.isLoading) return <Loading />;

  // Whatever the server put first, rather than a hard-coded module: a Core
  // instance and a Pro one with a dashboard should each land somewhere that
  // exists, and neither should land on a module the licence did not load.
  const chosen = profile.data?.preferences.landingPage;
  const landing =
    (chosen ? nav.find((n) => n.id === chosen) : undefined) ??
    nav.find((n) => n.id !== "settings") ??
    nav[0];
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
