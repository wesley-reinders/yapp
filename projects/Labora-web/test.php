<?php

use App\Models\User;

$users = User::limit(5)->get();

dd($users->toArray());
