# Rules for one project

Create a folder `<owner>/<repo>/` here for a project, with the rules that hold only for it: how its tests
and build run, where things live, the decisions a change must respect. An agent working on that project
reads its folder and the global rules, and nothing of the other projects.
