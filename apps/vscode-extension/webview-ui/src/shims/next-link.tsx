/**
 * Alias target for `next/link` inside the webview build.
 *
 * The studio only ever links to two routes ("/studio" and "/studio/:id") with
 * plain string hrefs — no `next/navigation`, no router hooks. So this shim
 * renders an <a> and, for internal links, drives a hash router by rewriting
 * `location.hash`. External links (http/https) fall through to a normal anchor.
 */
import { type AnchorHTMLAttributes, type ReactNode, type MouseEvent } from "react";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
};

export default function Link({ href, children, onClick, ...rest }: LinkProps) {
  const external = /^https?:\/\//i.test(href);

  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (external || e.defaultPrevented) return;
    e.preventDefault();
    const hash = "#" + (href.startsWith("/") ? href : "/" + href);
    if (window.location.hash !== hash) window.location.hash = hash;
    else window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  return (
    <a href={external ? href : "#" + href} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
