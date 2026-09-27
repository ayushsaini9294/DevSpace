import { z } from 'zod';

const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** POST /api/auth/signup — 201 AuthResponse and a session cookie; 409 `email_taken`; 400 `validation_error`. */
export const SignUpRequestSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email: EmailSchema,
  password: z.string().min(8, 'Use at least 8 characters').max(128),
});

/** POST /api/auth/login — 200 AuthResponse and a session cookie; 401 `invalid_credentials`. */
export const LogInRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  createdAt: z.iso.datetime(),
});

/** Returned by signup, login and GET /api/auth/me (401 `unauthenticated` when logged out). */
export const AuthResponseSchema = z.object({
  user: UserSchema,
});

export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;
export type LogInRequest = z.infer<typeof LogInRequestSchema>;
export type User = z.infer<typeof UserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/** HTTP-only session cookie. POST /api/auth/logout returns 204, deletes the session and clears it. */
export const SESSION_COOKIE_NAME = 'devspace_session';
