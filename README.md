# YAPP

**Yet Another PHP Playground**

YAPP is currently a minimum viable product (MVP).

YAPP is a local browser playground for trying Laravel queries, inspecting values, and running PHP snippets. Write PHP in Monaco on the left and see colorized output on the right.

Select a project and click **Manage snippets** to create, rename, favorite, or delete snippets. Favorites appear first in the manager and snippet dropdown and are saved in your browser. Open a snippet to edit it, then click **Save** to write your changes to disk or **Run snippet** to try the current editor contents.

YAPP stores snippets in `projects/<project>/snippets/` and creates the folder when needed. PHP files in a project’s root still open. Saving one writes its updated contents to `snippets/`, where YAPP looks first.

Each project runs snippets in its configured Docker container with Laravel bootstrapped. Intelephense reads the local checkout so you get autocomplete for your app’s models and dependencies as you type.
