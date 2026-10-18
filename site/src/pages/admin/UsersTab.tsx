import type { Component } from "solid-js";
import { copy } from "../../copy.ts";
import AuthorsTab from "./AuthorsTab.tsx";
import BansTab from "./BansTab.tsx";
import AdminsTab from "./AdminsTab.tsx";
import SpeedForm from "./SpeedForm.tsx";

/** Admin console, Users tab: everything an admin does to a person, stacked
 * as sections -- their display name (`AuthorsTab`), bans (`BansTab`), the
 * admin list (`AdminsTab`) and entering a typing speed for them
 * (`SpeedForm`). The first three are the former Authors, Bans and Admins
 * tabs, unchanged. */
const UsersTab: Component = () => {
  return (
    <div>
      <section class="akl-admin-section">
        <h2>{copy.admin.users.sectionAuthors}</h2>
        <AuthorsTab />
      </section>
      <section class="akl-admin-section">
        <h2>{copy.admin.users.sectionBans}</h2>
        <BansTab />
      </section>
      <section class="akl-admin-section">
        <h2>{copy.admin.users.sectionAdmins}</h2>
        <AdminsTab />
      </section>
      <section class="akl-admin-section">
        <h2>{copy.admin.users.sectionSpeed}</h2>
        <SpeedForm />
      </section>
    </div>
  );
};

export default UsersTab;
