/**
 * The Sentrello license verification key.
 *
 * Public keys are meant to be public: this ships in the open-source core so any
 * instance can verify a license token offline, with no network call and nothing
 * to configure. The matching private key exists only on sentrello.com's control
 * plane host.
 *
 * Rotating it is a breaking change for every instance in the field — a build
 * carrying the old key cannot verify tokens signed by a new one. If it ever has
 * to happen, ship a release that accepts both, wait for the fleet to update,
 * then drop the old one.
 */
export const SENTRELLO_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIolhK7dpfmkiCDtgITLc6tR09ju/zZ8jJDT/cmt1O5E=
-----END PUBLIC KEY-----
`;
